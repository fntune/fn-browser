import { PassThrough } from "node:stream";
import type { SessionId, TabId } from "@fn-browser/browser/cdp";
import { createBrowserProxy } from "@fn-browser/browser/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDaemonApp, type DaemonApp } from "../daemon/app.js";
import {
	type CommandFailure,
	type CommandResult,
	ExtensionBridge,
} from "../extension-bridge.js";
import { NativeMessagingBridge } from "../native-messaging.js";
import { browsersOf } from "./fixtures.js";

type FetchCall = {
	host: string;
	url: string;
};

type JsonRpcEnvelope = {
	jsonrpc: "2.0";
	id: string | number | null;
	result?: {
		content?: Array<{ type?: string; text?: string }>;
		isError?: boolean;
	};
	error?: { code: number; message: string; data?: unknown };
};

type ParsedToolResponse = {
	envelope: JsonRpcEnvelope;
	payload: unknown;
};

type ObservedDaemonEnvelope = ParsedToolResponse & {
	host: string;
};

type BridgeResponder = (
	method: string,
	params: Record<string, unknown>,
) => Promise<CommandResult | CommandFailure> | CommandResult | CommandFailure;

const primaryUrl = "http://primary.local";
const fallbackUrl = "http://fallback.local";
const authToken = "proxy-secret";
const attackerToken = "attacker-secret";
const sessionSigningKey = "proxy-session-signing-key-32-bytes-minimum";

const daemons: DaemonApp[] = [];

afterEach(() => {
	for (const daemon of daemons.splice(0)) {
		daemon.stopReaper();
	}
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("browser proxy failover against daemon HTTP surface", () => {
	it("healthy primary serves and pins to primary", async () => {
		const harness = createHarness({
			primaryBridge: stubBridge({ connected: true }),
		});

		const response = await harness.proxy(
			toolRequest(
				"rate_limit_check",
				{ tag: "healthy", max: 5, window: "minute" },
				"s-primary",
			),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("X-FN-Browser-Backend")).toBe("primary");
		const { envelope, payload } = await parseToolResponse(response);
		expect(envelope.result?.isError).toBeUndefined();
		expect(payload).toMatchObject({ allowed: true, remaining: 5 });
		expect(harness.calls.map((call) => call.host)).toEqual(["primary.local"]);
	});

	it("fails over a replay-safe read when the real primary daemon returns extension_unreachable", async () => {
		const sessionId = "s-extension-failover";
		const tabId = 1;
		const harness = createHarness({
			primaryBridge: stubBridge({ connected: false }),
			fallbackBridge: fallbackBridge(),
		});
		seedSessionTab(harness.primary, sessionId, tabId);
		seedSessionTab(harness.fallback, sessionId, tabId);

		const response = await harness.proxy(
			toolRequest("read_page", { tabId }, sessionId),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("X-FN-Browser-Backend")).toBe("fallback");
		const { envelope, payload } = await parseToolResponse(response);
		expect(envelope.result?.isError).toBeUndefined();
		expect(payload).toEqual({ from: "fallback" });
		expect(harness.calls.map((call) => call.host)).toEqual([
			"primary.local",
			"fallback.local",
		]);

		const primaryEnvelope = harness.envelopes.find(
			(entry) => entry.host === "primary.local",
		);
		expect(primaryEnvelope?.envelope.result?.isError).toBe(true);
		expect(primaryEnvelope?.payload).toMatchObject({
			error: { code: "extension_unreachable" },
		});
	});

	it("does not replay a mutation when the real primary daemon returns extension_unreachable", async () => {
		const sessionId = "s-mutation-no-replay";
		const tabId = 1;
		const harness = createHarness({
			primaryBridge: stubBridge({ connected: false }),
			fallbackBridge: fallbackBridge(),
		});
		seedSessionTab(harness.primary, sessionId, tabId);
		seedSessionTab(harness.fallback, sessionId, tabId);

		const response = await harness.proxy(
			toolRequest("navigate", { tabId, url: "https://example.com" }, sessionId),
		);

		expect(response.headers.get("X-FN-Browser-Backend")).toBe("primary");
		const { envelope, payload } = await parseToolResponse(response);
		expect(envelope.result?.isError).toBe(true);
		expect(payload).toMatchObject({
			error: { code: "extension_unreachable" },
		});
		expect(harness.calls.map((call) => call.host)).toEqual(["primary.local"]);
	});

	it("keeps a session sticky to fallback after failover", async () => {
		const sessionId = "s-sticky-fallback";
		const tabId = 1;
		const harness = createHarness({
			primaryBridge: stubBridge({ connected: false }),
			fallbackBridge: fallbackBridge(),
		});
		seedSessionTab(harness.primary, sessionId, tabId);
		seedSessionTab(harness.fallback, sessionId, tabId);

		const first = await harness.proxy(
			toolRequest("read_page", { tabId }, sessionId),
		);
		expect(first.headers.get("X-FN-Browser-Backend")).toBe("fallback");
		expect(harness.calls.map((call) => call.host)).toEqual([
			"primary.local",
			"fallback.local",
		]);

		harness.calls.length = 0;
		const second = await harness.proxy(
			toolRequest(
				"rate_limit_check",
				{ tag: "sticky", max: 5, window: "minute" },
				sessionId,
			),
		);

		expect(second.headers.get("X-FN-Browser-Backend")).toBe("fallback");
		const { envelope, payload } = await parseToolResponse(second);
		expect(envelope.result?.isError).toBeUndefined();
		expect(payload).toMatchObject({ allowed: true, remaining: 5 });
		expect(harness.calls.map((call) => call.host)).toEqual(["fallback.local"]);
	});

	it("exposes the empty ghost-restored fallback session (tabs must be re-established)", async () => {
		// The documented real failover state: the fallback is a DIFFERENT Chrome
		// with none of the session's tabs. We do NOT seed the fallback, so it
		// ghost-restores a minimal empty session for the unknown id — a tab-scoped
		// call referencing a primary-era tab must fail rather than silently act on
		// some unrelated tab.
		const sessionId = "s-empty-fallback";
		const harness = createHarness({
			primaryBridge: stubBridge({ connected: false }),
			fallbackBridge: fallbackBridge(),
		});
		seedSessionTab(harness.primary, sessionId, 99);

		const response = await harness.proxy(
			toolRequest("read_page", { tabId: 99 }, sessionId),
		);

		expect(response.headers.get("X-FN-Browser-Backend")).toBe("fallback");
		const { envelope, payload } = await parseToolResponse(response);
		expect(envelope.result?.isError).toBe(true);
		// The ghost-restored session owns no tabs, so tab 99 is not accessible.
		expect(payload).toMatchObject({
			error: { code: expect.stringMatching(/no_session|cross_session_tab/) },
		});
	});

	it("ghost-restores an authenticated failed-over session for its principal", async () => {
		const harness = createHarness({
			auth: true,
			primaryBridge: stubBridge({ connected: false }),
			fallbackBridge: fallbackBridge(),
		});
		const sessionId = await startAuthenticatedSession(harness.primary, authToken);
		expect(sessionId).toMatch(/^v1\./);
		seedSessionTab(harness.primary, sessionId, 99, "client");

		const response = await harness.proxy(
			toolRequest("read_page", { tabId: 99 }, sessionId),
		);

		expect(response.headers.get("X-FN-Browser-Backend")).toBe("fallback");
		expect(
			harness.fallback.mcpServer.sessions.ownerPrincipalId(sessionId),
		).toBe("client");
	});

	it("does not let another principal reserve a signed failover session id", async () => {
		const harness = createHarness({ auth: true });
		const sessionId = await startAuthenticatedSession(harness.primary, authToken);

		const attack = await harness.fallback.app.fetch(
			authenticatedToolRequest("info", { sessionId }, sessionId, attackerToken),
		);
		const attackBody = await parseToolResponse(attack);
		expect(attackBody.envelope.result?.isError).toBe(true);
		expect(attackBody.payload).toMatchObject({ error: { code: "no_session" } });
		expect(harness.fallback.mcpServer.sessions.has(sessionId)).toBe(false);

		const restored = await harness.fallback.app.fetch(
			authenticatedToolRequest("info", { sessionId }, sessionId, authToken),
		);
		const restoredBody = await parseToolResponse(restored);
		expect(restoredBody.envelope.result?.isError).toBeUndefined();
		expect(harness.fallback.mcpServer.sessions.ownerPrincipalId(sessionId)).toBe("client");
	});

	it("fails over when the primary daemon is unreachable", async () => {
		const harness = createHarness({ primaryDown: true });

		const response = await harness.proxy(
			toolRequest(
				"rate_limit_check",
				{ tag: "down", max: 5, window: "minute" },
				"s-down",
			),
		);

		expect(response.status).toBe(200);
		expect(response.headers.get("X-FN-Browser-Backend")).toBe("fallback");
		const { envelope, payload } = await parseToolResponse(response);
		expect(envelope.result?.isError).toBeUndefined();
		expect(payload).toMatchObject({ allowed: true, remaining: 5 });
		expect(harness.calls.map((call) => call.host)).toEqual([
			"primary.local",
			"fallback.local",
		]);
	});

	it("restores an argument-only session id on fallback", async () => {
		const sessionId = "s-argument-fallback";
		const harness = createHarness({ primaryDown: true });

		const response = await harness.proxy(
			argumentToolRequest("info", { sessionId }),
		);

		expect(response.headers.get("X-FN-Browser-Backend")).toBe("fallback");
		const { envelope, payload } = await parseToolResponse(response);
		expect(envelope.result?.isError).toBeUndefined();
		expect(payload).toMatchObject({ sessionId });
		expect(harness.fallback.mcpServer.sessions.has(sessionId as SessionId)).toBe(true);
	});
});

function createHarness(
	options: {
		primaryBridge?: ExtensionBridge;
		fallbackBridge?: ExtensionBridge;
		primaryDown?: boolean;
		auth?: boolean;
	} = {},
): {
	proxy: (request: Request) => Promise<Response>;
	primary: DaemonApp;
	fallback: DaemonApp;
	calls: FetchCall[];
	envelopes: ObservedDaemonEnvelope[];
} {
	if (options.auth) {
		enableDaemonAuth();
	} else {
		disableDaemonAuth();
	}

	const primary = createDaemonApp({
		browsers: browsersOf(options.primaryBridge ?? stubBridge({ connected: true })),
	});
	const fallback = createDaemonApp({
		browsers: browsersOf(options.fallbackBridge ?? fallbackBridge()),
	});
	daemons.push(primary, fallback);

	const calls: FetchCall[] = [];
	const envelopes: ObservedDaemonEnvelope[] = [];

	vi.stubGlobal(
		"fetch",
		vi.fn(
			async (
				input: RequestInfo | URL,
				init?: RequestInit,
			): Promise<Response> => {
				const url = urlFromInput(input);
				const host = new URL(url).host;
				calls.push({ host, url });

				if (options.primaryDown && host === "primary.local") {
					throw new TypeError("connect ECONNREFUSED primary.local");
				}

				const daemon =
					host === "primary.local"
						? primary
						: host === "fallback.local"
							? fallback
							: null;
				if (!daemon) throw new Error(`unexpected backend host: ${host}`);

				const response = await daemon.app.fetch(new Request(url, init));
				await observeDaemonEnvelope(host, response, envelopes);
				return response;
			},
		),
	);

	return {
		proxy: createBrowserProxy({
			primaryUrl,
			fallbackUrl,
			...(options.auth ? { primaryToken: authToken, fallbackToken: authToken } : {}),
		}),
		primary,
		fallback,
		calls,
		envelopes,
	};
}

function enableDaemonAuth(): void {
	vi.stubEnv(
		"FN_BROWSER_AUTH_TOKENS",
		`client:${authToken}:admin,attacker:${attackerToken}:admin`,
	);
	vi.stubEnv("FN_BROWSER_SESSION_SIGNING_KEY", sessionSigningKey);
	vi.stubEnv("FN_BROWSER_TRUST_IDENTITY_HEADER", "");
	vi.stubEnv("FN_BROWSER_IDENTITY_TIERS", "");
}

function disableDaemonAuth(): void {
	vi.stubEnv("FN_BROWSER_AUTH_TOKENS", "");
	vi.stubEnv("FN_BROWSER_SESSION_SIGNING_KEY", "");
	vi.stubEnv("FN_BROWSER_TRUST_IDENTITY_HEADER", "");
	vi.stubEnv("FN_BROWSER_IDENTITY_TIERS", "");
}

function stubBridge(
	options: { connected?: boolean; respond?: BridgeResponder } = {},
): ExtensionBridge {
	const bridge = new ExtensionBridge(
		new NativeMessagingBridge(new PassThrough(), new PassThrough()),
	);
	const connected = options.connected ?? true;
	const respond =
		options.respond ??
		(async (): Promise<CommandResult> => ({
			ok: true,
			result: null,
		}));

	Object.defineProperty(bridge, "isConnected", {
		configurable: true,
		get: () => connected,
	});
	Object.assign(bridge, {
		async sendCommand(
			method: string,
			params: Record<string, unknown>,
		): Promise<CommandResult | CommandFailure> {
			if (!connected) {
				return {
					ok: false,
					error: {
						code: "extension_unreachable",
						message: "Extension is disconnected.",
					},
				};
			}
			return respond(method, params);
		},
	});

	return bridge;
}

function fallbackBridge(): ExtensionBridge {
	return stubBridge({
		connected: true,
		respond: async (method, params): Promise<CommandResult> => {
			if (method === "navigate") {
				return {
					ok: true,
					result: { from: "fallback", url: params.url },
				};
			}
			return { ok: true, result: { from: "fallback" } };
		},
	});
}

function seedSessionTab(
	daemon: DaemonApp,
	sessionId: string,
	tabId: number,
	ownerPrincipalId?: string,
): void {
	const id = sessionId as SessionId;
	if (!daemon.mcpServer.sessions.has(id)) {
		daemon.mcpServer.sessions.create({
			id,
			name: "seeded",
			...(ownerPrincipalId ? { ownerPrincipalId } : {}),
		});
	}
	daemon.mcpServer.sessions.attachTab(id, tabId as TabId);
}

function toolRequest(
	name: string,
	args: Record<string, unknown>,
	sessionId: string,
): Request {
	return new Request("http://proxy.local/mcp/browser", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-Session-Id": sessionId,
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});
}

function argumentToolRequest(
	name: string,
	args: Record<string, unknown>,
): Request {
	return new Request("http://proxy.local/mcp/browser", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});
}

function authenticatedToolRequest(
	name: string,
	args: Record<string, unknown>,
	sessionId: string | undefined,
	token: string,
): Request {
	return new Request("http://fallback.local/mcp/browser", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token}`,
			"Content-Type": "application/json",
			...(sessionId ? { "X-Session-Id": sessionId } : {}),
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		}),
	});
}

async function startAuthenticatedSession(
	daemon: DaemonApp,
	token: string,
): Promise<SessionId> {
	const response = await daemon.app.fetch(
		authenticatedToolRequest("start", {}, undefined, token),
	);
	const { envelope, payload } = await parseToolResponse(response);
	if (envelope.result?.isError || typeof payload !== "object" || payload === null) {
		throw new Error("authenticated start did not return a session");
	}
	const sessionId = (payload as { sessionId?: unknown }).sessionId;
	if (typeof sessionId !== "string") {
		throw new Error("authenticated start did not return a sessionId");
	}
	return sessionId as SessionId;
}

function urlFromInput(input: RequestInfo | URL): string {
	if (typeof input === "string") return input;
	if (input instanceof URL) return input.href;
	return input.url;
}

async function observeDaemonEnvelope(
	host: string,
	response: Response,
	envelopes: ObservedDaemonEnvelope[],
): Promise<void> {
	if (
		!response.headers
			.get("content-type")
			?.toLowerCase()
			.includes("application/json")
	) {
		return;
	}

	const envelope = (await response.clone().json()) as JsonRpcEnvelope;
	const text = firstToolText(envelope);
	if (!text) return;

	envelopes.push({
		host,
		envelope,
		payload: JSON.parse(text) as unknown,
	});
}

async function parseToolResponse(
	response: Response,
): Promise<ParsedToolResponse> {
	const envelope = (await response.json()) as JsonRpcEnvelope;
	const text = firstToolText(envelope);
	if (!text) {
		throw new Error("response did not contain an MCP text content item");
	}
	return {
		envelope,
		payload: JSON.parse(text) as unknown,
	};
}

function firstToolText(envelope: JsonRpcEnvelope): string | null {
	const first = envelope.result?.content?.[0];
	return typeof first?.text === "string" ? first.text : null;
}
