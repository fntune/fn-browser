/**
 * Load `~/.fn-browser/env` into `process.env` for entrypoints Chrome spawns.
 *
 * The launchd wrapper (`fn-browserd-launch.sh`) sources this file before exec,
 * but the Chrome-spawned shim gets Chrome's minimal environment — without this
 * loader, secrets like `FN_BROWSER_AUTH_TOKENS` written by the installer would
 * silently never bind in shim mode. Real environment variables always win:
 * a key present in `process.env` before this runs is never overwritten, so
 * launchd / shell-set values keep precedence and sourcing twice is harmless.
 *
 * Within the file, a later assignment of the same key overrides an earlier one
 * — matching how bash `source` (used by the launchd wrapper) keeps the last
 * value. Otherwise the shim would pin the first value while launchd took the
 * last, so a rotated token could authenticate in one mode and 401 in the other.
 *
 * Format: `KEY=VALUE` lines; blank lines and `#` comments ignored; an optional
 * `export ` prefix and surrounding single/double quotes are stripped (the same
 * file is `source`d by bash under `set -a`).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

function stripInlineComment(value: string): string {
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < value.length; index++) {
		const char = value[index];
		if (char === "\\" && quote !== "'") {
			index++;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === "#" && (index === 0 || /\s/.test(value[index - 1] ?? ""))) {
			return value.slice(0, index).trimEnd();
		}
	}
	return value;
}

export function loadEnvFile(
	path: string = join(homedir(), ".fn-browser", "env"),
): void {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (err) {
		// A genuinely absent file is fine — there's nothing to load. But a file
		// that exists and can't be read (wrong owner/permissions, I/O error) must
		// fail closed: silently continuing would start the host with no token,
		// and an empty token table disables MCP auth entirely — turning a
		// permissions mistake into an unauthenticated browser-control endpoint.
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
		throw new Error(
			`fn-browser: ~/.fn-browser/env exists but could not be read (${(err as NodeJS.ErrnoException)?.code ?? "unknown"}). ` +
				"Refusing to start without loading it — fix its ownership/permissions or remove it.",
			{ cause: err },
		);
	}

	// Keys that were set in the real environment before this loader ran — those
	// always win over the file. Keys the file itself sets are not in this set, so
	// a later file line can still override an earlier one.
	const realEnvironmentKeys = new Set(Object.keys(process.env));

	for (const rawLine of text.split("\n")) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#")) continue;
		const assignment = line.startsWith("export ")
			? line.slice("export ".length).trim()
			: line;
		const eq = assignment.indexOf("=");
		if (eq <= 0) continue;
		const key = assignment.slice(0, eq).trim();
		let value = stripInlineComment(assignment.slice(eq + 1).trim());
		if (
			value.length >= 2 &&
			((value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'")))
		) {
			value = value.slice(1, -1);
		}
		if (!realEnvironmentKeys.has(key)) {
			process.env[key] = value;
		}
	}
}
