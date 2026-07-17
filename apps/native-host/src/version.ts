import pkg from "../package.json";

/**
 * Single source of truth for the host version.
 *
 * Sourced from `@fntune/native-host`'s package.json — Bun inlines this JSON at
 * `--compile` time, so the standalone binary carries the literal with no runtime
 * file read. To release a new host version, bump `version` in package.json only;
 * the `/health` payload, the `hello_ack` frame, and the MCP `serverInfo` all
 * follow from here.
 */
export const HOST_VERSION: string = pkg.version;
