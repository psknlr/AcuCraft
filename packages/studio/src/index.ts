/**
 * @acucraft/studio — one live encounter for a human operator and a language model (docs/STUDIO.md): the session
 * (the only holder of the state and the one way to act on it), its HTTP interface with live events, the MCP bridge,
 * and the build of the real-time 3D client.
 */
export * from "./catalogue.js";
export * from "./scene.js";
export * from "./session.js";
export * from "./server.js";
export * from "./mcp.js";
export { buildClient, clientBuilt, CLIENT_DIST, CLIENT_SRC } from "./build.js";
