/**
 * @acucraft/mcp — encounters served to an MCP client: an external agent plays the practitioner with the same tools
 * as the built-in one — over stdio (`acu mcp`, encounters of its own) or over HTTP on the live records of the browser
 * workspace (`acu serve`, `@acucraft/server`). See docs/AGENT.md and docs/WEB.md.
 */
export * from "./jsonrpc.js";
export * from "./store.js";
export * from "./server.js";
