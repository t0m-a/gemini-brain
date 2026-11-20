/**
 * File: C:\Users\simon\Workspaces\gemini-brain\src\version.ts
 * Purpose: Single source of truth for the Gemini Brain release version,
 *          imported directly from package.json for MCP handshake, SEP-2127
 *          server card, API metadata, and the Cognitive NOC Dashboard.
 */

import pkg from "../package.json";

export const BRAIN_VERSION: string = pkg.version;
