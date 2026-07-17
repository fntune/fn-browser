/**
 * Load `~/.fn-browser/env` into `process.env`. Real env vars win; within the file,
 * later lines override earlier (matches bash `source`). Unreadable existing file
 * fails closed — empty tokens would disable MCP auth.
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
		// Fail closed on unreadable file — don't start with empty auth tokens.
		if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return;
		throw new Error(
			`fn-browser: ~/.fn-browser/env exists but could not be read (${(err as NodeJS.ErrnoException)?.code ?? "unknown"}). ` +
				"Refusing to start without loading it — fix its ownership/permissions or remove it.",
			{ cause: err },
		);
	}

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
