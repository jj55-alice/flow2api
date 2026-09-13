import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const bridgeSource = await readFile(new URL("../extension/auth_bridge.js", import.meta.url), "utf8");

function loadBridge() {
    const listeners = new Map();
    const sent = [];
    const pageWindow = {
        addEventListener(type, listener) {
            listeners.set(type, listener);
        },
        postMessage() {},
    };
    const context = {
        window: pageWindow,
        location: { origin: "https://flow.google.com" },
        chrome: {
            runtime: {
                lastError: null,
                sendMessage(message, callback) {
                    sent.push(message);
                    callback?.();
                },
            },
        },
        Number,
        String,
    };
    vm.runInNewContext(bridgeSource, context);
    return { listener: listeners.get("message"), pageWindow, sent };
}

test("page progress is forwarded to the extension runtime", () => {
    const { listener, pageWindow, sent } = loadBridge();
    listener({
        source: pageWindow,
        origin: "https://flow.google.com",
        data: {
            source: "flow2api-submit-progress",
            type: "flow_submit_progress",
            request_id: "request-123",
            phase: "waiting:Flow native upload product.jpg",
            updated_at: 12345,
        },
    });

    assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{
        type: "flow_submit_progress_bridge",
        request_id: "request-123",
        phase: "waiting:Flow native upload product.jpg",
        updated_at: 12345,
    }]);
});

test("foreign or malformed progress messages are ignored", () => {
    const { listener, pageWindow, sent } = loadBridge();
    const valid = {
        source: "flow2api-submit-progress",
        type: "flow_submit_progress",
        request_id: "request-123",
        phase: "generating",
        updated_at: 12345,
    };
    listener({ source: {}, origin: "https://flow.google.com", data: valid });
    listener({ source: pageWindow, origin: "https://evil.example", data: valid });
    listener({
        source: pageWindow,
        origin: "https://flow.google.com",
        data: { ...valid, phase: "generating\nforged" },
    });

    assert.equal(sent.length, 0);
});
