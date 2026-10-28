/**
 * FN_BROWSER_AUTH_SCOPE=mcp — the local single-user posture: bearer auth gates
 * only /mcp/* while side-panel control routes keep loopback trust — plus the
 * ~/.fn-browser/env loader the Chrome-spawned shim relies on to see the
 * installer-written token at all.
 */

import { spawnSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { parseAuthScope } from "../auth/tokens.js";
import { createDaemonApp } from "../daemon/app.js";
import { loadEnvFile } from "../env-file.js";
import { ExtensionBridge } from "../extension-bridge.js";
import { NativeMessagingBridge } from "../native-messaging.js";
import { browsersOf } from "./fixtures.js";

function stubBridge(): ExtensionBridge {
	const bridge = new ExtensionBridge(
		new NativeMessagingBridge(new PassThrough(), new PassThrough()),
	);
	Object.defineProperty(bridge, "isConnected", { get: () => true });
	Object.assign(bridge, {
		async sendCommand() {
			return { ok: true, result: null };
		},
	});
	return bridge;
}

const AUTH_ENV_KEYS = [
	"FN_BROWSER_AUTH_TOKENS",
	"FN_BROWSER_AUTH_SCOPE",
] as const;

async function withAuthEnv<T>(
	env: Partial<Record<(typeof AUTH_ENV_KEYS)[number], string>>,
	fn: () => T | Promise<T>,
): Promise<T> {
	const prev = new Map(AUTH_ENV_KEYS.map((k) => [k, process.env[k]] as const));
	for (const key of AUTH_ENV_KEYS) delete process.env[key];
	for (const [key, value] of Object.entries(env)) process.env[key] = value;
	try {
		return await fn();
	} finally {
		for (const [key, value] of prev) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function mcpCall(token?: string): RequestInit {
	return {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(token ? { Authorization: `Bearer ${token}` } : {}),
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "evaluate_js", arguments: {} },
		}),
	};
}

describe("parseAuthScope", () => {
	it("defaults to all when unset or blank", () => {
		expect(parseAuthScope(undefined)).toBe("all");
		expect(parseAuthScope("  ")).toBe("all");
	});

	it("accepts all and mcp (case-insensitive)", () => {
		expect(parseAuthScope("all")).toBe("all");
		expect(parseAuthScope("MCP")).toBe("mcp");
	});

	it("throws on an unknown scope rather than silently widening auth", () => {
		expect(() => parseAuthScope("panel")).toThrow(/unknown scope "panel"/);
	});
});

describe("FN_BROWSER_AUTH_SCOPE=mcp", () => {
	const tokens = "cli:tok_act:act,desk:tok_admin:admin";

	it("refuses to start without a bearer principal", async () => {
		await withAuthEnv(
			{ FN_BROWSER_AUTH_TOKENS: "", FN_BROWSER_AUTH_SCOPE: "mcp" },
			() => {
				expect(() => createDaemonApp({ browsers: browsersOf(stubBridge()) })).toThrow(
					/requires at least one bearer principal/,
				);
			},
		);
	});

	it("gates /mcp/* with the bearer token", async () => {
		await withAuthEnv(
			{ FN_BROWSER_AUTH_TOKENS: tokens, FN_BROWSER_AUTH_SCOPE: "mcp" },
			async () => {
				const { app } = createDaemonApp({ browsers: browsersOf(stubBridge()) });
				const anon = await app.request("/mcp/browser", mcpCall());
				expect(anon.status).toBe(401);
				const authed = await app.request("/mcp/browser", mcpCall("tok_admin"));
				expect(authed.status).toBe(200);
			},
		);
	});

	it("keeps side-panel routes reachable without a token", async () => {
		await withAuthEnv(
			{ FN_BROWSER_AUTH_TOKENS: tokens, FN_BROWSER_AUTH_SCOPE: "mcp" },
			async () => {
				const { app } = createDaemonApp({ browsers: browsersOf(stubBridge()) });
				for (const path of ["/health", "/sessions", "/rate-limits"]) {
					const res = await app.request(path);
					expect(res.status, path).toBe(200);
				}
			},
		);
	});

	it("does not overwrite an authenticated /mcp principal with local admin", async () => {
		await withAuthEnv(
			{ FN_BROWSER_AUTH_TOKENS: tokens, FN_BROWSER_AUTH_SCOPE: "mcp" },
			async () => {
				const { app } = createDaemonApp({ browsers: browsersOf(stubBridge()) });
				// evaluate_js needs the admin tier — an act token must still be refused
				// (if the loopback-trust fallback also ran on /mcp/*, it would escalate
				// every authenticated caller to local admin and this would succeed).
				const res = await app.request("/mcp/browser", mcpCall("tok_act"));
				const body = (await res.json()) as { error?: { code: number } };
				expect(body.error?.code).toBe(-32003);
			},
		);
	});

	it("all-scope (default) still gates every route", async () => {
		await withAuthEnv({ FN_BROWSER_AUTH_TOKENS: tokens }, async () => {
			const { app } = createDaemonApp({ browsers: browsersOf(stubBridge()) });
			expect((await app.request("/sessions")).status).toBe(401);
		});
	});

	it("refuses a non-loopback bind (panel routes would be open on the network)", async () => {
		await withAuthEnv(
			{ FN_BROWSER_AUTH_TOKENS: tokens, FN_BROWSER_AUTH_SCOPE: "mcp" },
			() => {
				expect(() =>
					createDaemonApp({ browsers: browsersOf(stubBridge()), bind: "0.0.0.0" }),
				).toThrow(/requires a loopback bind/);
			},
		);
	});
});

describe("loadEnvFile", () => {
	function withTempEnvFile<T>(content: string, fn: (path: string) => T): T {
		const dir = mkdtempSync(join(tmpdir(), "fn-env-"));
		const path = join(dir, "env");
		writeFileSync(path, content);
		try {
			return fn(path);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}

	it("loads KEY=VALUE lines, ignoring comments, blanks, export prefixes, and quotes", () => {
		withTempEnvFile(
			[
				"# comment",
				"",
				"FN_TEST_PLAIN=hello",
				'export FN_TEST_EXPORTED="quoted value"',
				"FN_TEST_SINGLE='single'",
				"not-an-assignment",
			].join("\n"),
			(path) => {
				try {
					loadEnvFile(path);
					expect(process.env.FN_TEST_PLAIN).toBe("hello");
					expect(process.env.FN_TEST_EXPORTED).toBe("quoted value");
					expect(process.env.FN_TEST_SINGLE).toBe("single");
				} finally {
					delete process.env.FN_TEST_PLAIN;
					delete process.env.FN_TEST_EXPORTED;
					delete process.env.FN_TEST_SINGLE;
				}
			},
		);
	});

	it("never overwrites a variable already present in the real environment", () => {
		process.env.FN_TEST_PRESET = "real";
		try {
			withTempEnvFile("FN_TEST_PRESET=from-file", (path) => {
				loadEnvFile(path);
				expect(process.env.FN_TEST_PRESET).toBe("real");
			});
		} finally {
			delete process.env.FN_TEST_PRESET;
		}
	});

	it("strips unquoted inline comments while preserving quoted hashes", () => {
		withTempEnvFile(
			[
				"FN_TEST_INLINE=plain # operator note",
				'FN_TEST_QUOTED="quoted # value" # operator note',
			].join("\n"),
			(path) => {
				try {
					loadEnvFile(path);
					expect(process.env.FN_TEST_INLINE).toBe("plain");
					expect(process.env.FN_TEST_QUOTED).toBe("quoted # value");
				} finally {
					delete process.env.FN_TEST_INLINE;
					delete process.env.FN_TEST_QUOTED;
				}
			},
		);
	});

	it("uses the last repeated file assignment while preserving real environment precedence", () => {
		delete process.env.FN_TEST_ROTATED;
		try {
			withTempEnvFile(
				["FN_TEST_ROTATED=old", "FN_TEST_ROTATED=new"].join("\n"),
				(path) => {
					loadEnvFile(path);
					expect(process.env.FN_TEST_ROTATED).toBe("new");
				},
			);

			process.env.FN_TEST_ROTATED = "real";
			withTempEnvFile(
				["FN_TEST_ROTATED=old", "FN_TEST_ROTATED=new"].join("\n"),
				(path) => {
					loadEnvFile(path);
					expect(process.env.FN_TEST_ROTATED).toBe("real");
				},
			);
		} finally {
			delete process.env.FN_TEST_ROTATED;
		}
	});

	it("is a no-op when the file does not exist", () => {
		expect(() => loadEnvFile("/nonexistent/fn-browser/env")).not.toThrow();
	});

	it("fails closed when the file exists but cannot be read", () => {
		// A directory at the path yields EISDIR (not ENOENT) on read — stands in
		// for a permission/ownership error. Silently continuing would start the
		// host with no token and disable MCP auth, so it must throw.
		const dir = mkdtempSync(join(tmpdir(), "fn-env-unreadable-"));
		try {
			expect(() => loadEnvFile(dir)).toThrow(/could not be read/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("native-host installer auth provisioning", () => {
	function runInstaller(
		envContent: string,
		mode = 0o644,
	): {
		env: string;
		mode: number;
		stderr: string;
		stdout: string;
	} {
		const root = mkdtempSync(join(tmpdir(), "fn-installer-"));
		const home = join(root, "home");
		const host = join(root, "host");
		const install = join(host, "install");
		const envPath = join(home, ".fn-browser", "env");
		mkdirSync(join(host, "bin"), { recursive: true });
		mkdirSync(install, { recursive: true });
		mkdirSync(join(home, "Library/Application Support/Google/Chrome"), {
			recursive: true,
		});
		mkdirSync(join(home, ".config/google-chrome"), { recursive: true });
		mkdirSync(join(home, ".fn-browser"), { recursive: true });
		copyFileSync(
			join(process.cwd(), "install/install.sh"),
			join(install, "install.sh"),
		);
		writeFileSync(join(host, "bin/host"), "#!/usr/bin/env bash\nexit 0\n");
		chmodSync(join(host, "bin/host"), 0o755);
		writeFileSync(envPath, envContent);
		chmodSync(envPath, mode);

		try {
			const result = spawnSync("bash", [join(install, "install.sh")], {
				encoding: "utf8",
				env: { ...process.env, HOME: home },
			});
			expect(result.status, result.stderr).toBe(0);
			return {
				env: readFileSync(envPath, "utf8"),
				mode: statSync(envPath).mode & 0o777,
				stderr: result.stderr,
				stdout: result.stdout,
			};
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}

	it("replaces an empty token assignment and locks down the file", () => {
		const result = runInstaller('FN_BROWSER_AUTH_TOKENS=""\n');

		expect(result.env).toMatch(
			/FN_BROWSER_AUTH_TOKENS=claude:[a-f0-9]{48}:admin/,
		);
		expect(result.mode).toBe(0o600);
	});

	it("uses the last repeated token assignment when deciding whether to provision", () => {
		const result = runInstaller(
			[
				"FN_BROWSER_AUTH_TOKENS=stale:old-secret:admin",
				'FN_BROWSER_AUTH_TOKENS=""',
			].join("\n"),
		);

		expect(result.env).toMatch(
			/FN_BROWSER_AUTH_TOKENS=claude:[a-f0-9]{48}:admin/,
		);
		expect(result.env.match(/FN_BROWSER_AUTH_TOKENS=/g)).toHaveLength(3);
	});

	it("preserves an existing remote daemon scope and locks down the file", () => {
		const result = runInstaller(
			[
				"FN_BROWSER_AUTH_TOKENS=remote:secret:admin",
				"FN_BROWSER_BIND=0.0.0.0",
			].join("\n"),
		);

		expect(result.env).not.toContain("FN_BROWSER_AUTH_SCOPE=mcp");
		expect(result.env.match(/FN_BROWSER_AUTH_TOKENS=/g)).toHaveLength(1);
		expect(result.mode).toBe(0o600);
	});
});
