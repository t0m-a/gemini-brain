/**
 * File: C:\Users\simon\Workspaces\gemini-brain\src\dashboard.ts
 * Purpose: Self-contained Cognitive NOC Web Visualization Dashboard for brain.tsimon.me
 *          Implements Option A (Browser Session Auth with zero embedded secrets) and 5 interactive visual modules:
 *          1. Interactive 2D Force-Directed Knowledge Graph Canvas (PageRank sizing + Edge Inspector)
 *          2. Connected Surfaces & Storage Databases Topology Matrix (including RPi5 Edge Sync & Knowledge Graph)
 *          3. Memory Types Status & Content Explorer by Namespace (semantic, procedural, episodic_summary, ADRs)
 *          4. 4-Way Federated RRF Search Playground & Score Inspector
 *          5. Nocturnal 03:00 AM Sleep Cycle, Episodic Queue & Before/After Mutation Diff Viewer with 1-Click Rollback
 */

export function renderDashboardHtml(primaryDomain = "tsimon.me", version = "1.7.3"): string {
  return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'%3E%3Crect width='64' height='64' rx='14' fill='%230b1120'/%3E%3Ccircle cx='32' cy='32' r='18' fill='none' stroke='%2306b6d4' stroke-width='4'/%3E%3Ccircle cx='32' cy='32' r='7' fill='%2310b981'/%3E%3C/svg%3E" />
  <title>Gemini Brain NOC — Cognitive Telemetry & Knowledge Graph (brain.${primaryDomain})</title>
  <style>
    :root {
      --bg-0: #060911;
      --bg-1: #0b1120;
      --bg-2: #111827;
      --bg-3: #1e293b;
      --border: #1e293b;
      --border-hi: #334155;
      --text-0: #f8fafc;
      --text-1: #cbd5e1;
      --text-2: #94a3b8;
      --text-3: #64748b;
      --cyan: #06b6d4;
      --cyan-glow: rgba(6, 182, 212, 0.18);
      --emerald: #10b981;
      --emerald-glow: rgba(16, 185, 129, 0.18);
      --violet: #8b5cf6;
      --violet-glow: rgba(139, 92, 246, 0.18);
      --amber: #f59e0b;
      --amber-glow: rgba(245, 158, 11, 0.18);
      --rose: #f43f5e;
      --rose-glow: rgba(244, 63, 94, 0.18);
      --blue: #3b82f6;
      --font-sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --font-mono: "JetBrains Mono", "Fira Code", Consolas, monospace;
    }

    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }

    body {
      background: radial-gradient(circle at 15% 0%, #0f172a 0%, var(--bg-0) 65%);
      color: var(--text-0);
      font-family: var(--font-sans);
      min-height: 100vh;
      overflow-x: hidden;
      line-height: 1.45;
    }

    /* Login Overlay (Option A: Browser Session Auth) */
    #auth-overlay {
      position: fixed;
      inset: 0;
      z-index: 9999;
      background: rgba(6, 9, 17, 0.92);
      backdrop-filter: blur(14px);
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    #auth-overlay.hidden {
      display: none;
    }
    .auth-card {
      width: 100%;
      max-width: 480px;
      background: linear-gradient(180deg, #111827 0%, #0b1120 100%);
      border: 1px solid var(--border-hi);
      border-radius: 14px;
      padding: 28px;
      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.65), 0 0 40px var(--cyan-glow);
    }
    .auth-logo {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 6px 12px;
      border-radius: 999px;
      background: rgba(6, 182, 212, 0.12);
      border: 1px solid rgba(6, 182, 212, 0.35);
      color: var(--cyan);
      font-size: 12px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      margin-bottom: 16px;
    }
    .auth-title {
      font-size: 22px;
      font-weight: 700;
      color: var(--text-0);
      margin-bottom: 8px;
    }
    .auth-subtitle {
      font-size: 13px;
      color: var(--text-2);
      margin-bottom: 20px;
    }
    .form-group {
      margin-bottom: 16px;
    }
    .form-label {
      display: block;
      font-size: 12px;
      font-weight: 600;
      color: var(--text-1);
      margin-bottom: 6px;
    }
    .form-input, .form-select {
      width: 100%;
      padding: 10px 12px;
      background: var(--bg-0);
      border: 1px solid var(--border-hi);
      border-radius: 8px;
      color: var(--text-0);
      font-family: var(--font-mono);
      font-size: 13px;
      outline: none;
      transition: border-color 0.15s ease;
    }
    .form-input:focus, .form-select:focus {
      border-color: var(--cyan);
      box-shadow: 0 0 0 2px var(--cyan-glow);
    }
    .auth-helper {
      background: rgba(15, 23, 42, 0.8);
      border: 1px dashed var(--border-hi);
      border-radius: 8px;
      padding: 10px 12px;
      font-size: 11.5px;
      color: var(--text-2);
      margin-bottom: 16px;
    }
    .auth-helper code {
      display: block;
      font-family: var(--font-mono);
      color: var(--cyan);
      margin-top: 6px;
      word-break: break-all;
      background: var(--bg-0);
      padding: 6px 8px;
      border-radius: 6px;
      border: 1px solid var(--border);
    }
    .auth-error {
      color: var(--rose);
      background: var(--rose-glow);
      border: 1px solid rgba(244, 63, 94, 0.35);
      border-radius: 8px;
      padding: 9px 12px;
      font-size: 12px;
      margin-bottom: 14px;
      display: none;
    }

    /* Buttons & Badges */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 8px 14px;
      border-radius: 8px;
      font-size: 12.5px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid var(--border-hi);
      background: var(--bg-2);
      color: var(--text-0);
      transition: all 0.15s ease;
      white-space: nowrap;
    }
    .btn:hover {
      background: var(--bg-3);
      border-color: var(--text-3);
    }
    .btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .btn-primary {
      background: linear-gradient(135deg, #0891b2 0%, #2563eb 100%);
      border-color: #06b6d4;
      color: #fff;
    }
    .btn-primary:hover {
      filter: brightness(1.1);
    }
    .btn-emerald {
      background: rgba(16, 185, 129, 0.15);
      border-color: rgba(16, 185, 129, 0.45);
      color: #34d399;
    }
    .btn-amber {
      background: rgba(245, 158, 11, 0.15);
      border-color: rgba(245, 158, 11, 0.45);
      color: #fbbf24;
    }
    .btn-rose {
      background: rgba(244, 63, 94, 0.15);
      border-color: rgba(244, 63, 94, 0.45);
      color: #fb7185;
    }
    .btn-sm {
      padding: 4px 10px;
      font-size: 11.5px;
      border-radius: 6px;
    }

    .badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      font-family: var(--font-mono);
    }
    .badge-emerald {
      background: var(--emerald-glow);
      color: #34d399;
      border: 1px solid rgba(16, 185, 129, 0.35);
    }
    .badge-cyan {
      background: var(--cyan-glow);
      color: #22d3ee;
      border: 1px solid rgba(6, 182, 212, 0.35);
    }
    .badge-violet {
      background: var(--violet-glow);
      color: #c084fc;
      border: 1px solid rgba(139, 92, 246, 0.35);
    }
    .badge-amber {
      background: var(--amber-glow);
      color: #fbbf24;
      border: 1px solid rgba(245, 158, 11, 0.35);
    }
    .badge-rose {
      background: var(--rose-glow);
      color: #fb7185;
      border: 1px solid rgba(244, 63, 94, 0.35);
    }
    .badge-slate {
      background: rgba(100, 116, 139, 0.2);
      color: var(--text-1);
      border: 1px solid rgba(100, 116, 139, 0.35);
    }

    /* Top Header & System Pulse */
    .top-header {
      position: sticky;
      top: 0;
      z-index: 100;
      background: rgba(11, 17, 32, 0.88);
      backdrop-filter: blur(12px);
      border-bottom: 1px solid var(--border);
      padding: 12px 20px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    .brand-group {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .pulse-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--emerald);
      box-shadow: 0 0 12px var(--emerald);
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.25); opacity: 0.65; }
    }
    .brand-title {
      font-size: 16px;
      font-weight: 700;
      letter-spacing: -0.01em;
    }
    .brand-sub {
      font-size: 11.5px;
      color: var(--text-2);
      font-family: var(--font-mono);
    }

    .kpi-strip {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 10px;
    }
    .kpi-pill {
      background: var(--bg-2);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 5px 11px;
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 12px;
    }
    .kpi-pill .label {
      color: var(--text-2);
      font-size: 11px;
    }
    .kpi-pill .val {
      font-family: var(--font-mono);
      font-weight: 700;
      color: var(--text-0);
    }

    /* Navigation Tabs */
    .nav-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 10px;
      padding: 10px 20px;
      background: var(--bg-1);
      border-bottom: 1px solid var(--border);
    }
    .tab-group {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .tab-btn {
      padding: 7px 14px;
      border-radius: 8px;
      font-size: 12.5px;
      font-weight: 600;
      color: var(--text-2);
      background: transparent;
      border: 1px solid transparent;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 7px;
      transition: all 0.15s ease;
    }
    .tab-btn:hover {
      color: var(--text-0);
      background: rgba(255, 255, 255, 0.04);
    }
    .tab-btn.active {
      color: var(--cyan);
      background: rgba(6, 182, 212, 0.12);
      border-color: rgba(6, 182, 212, 0.35);
    }

    /* Main Layout Containers */
    .view-section {
      display: none;
      padding: 18px 20px 40px;
      max-width: 1920px;
      margin: 0 auto;
    }
    .view-section.active {
      display: block;
    }

    .noc-grid {
      display: grid;
      grid-template-columns: 350px 1fr 410px;
      gap: 16px;
      align-items: start;
    }
    @media (max-width: 1440px) {
      .noc-grid {
        grid-template-columns: 320px 1fr;
      }
      .noc-right-col {
        grid-column: 1 / -1;
      }
    }
    @media (max-width: 1024px) {
      .noc-grid {
        grid-template-columns: 1fr;
      }
    }

    .panel {
      background: rgba(17, 24, 39, 0.85);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      margin-bottom: 16px;
    }
    .panel-header {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      background: rgba(11, 17, 32, 0.6);
    }
    .panel-title {
      font-size: 13px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-1);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .panel-body {
      padding: 14px 16px;
    }

    /* Surface & Database Cards */
    .surface-card {
      background: var(--bg-1);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 11px 13px;
      margin-bottom: 10px;
      transition: border-color 0.15s ease;
    }
    .surface-card:last-child {
      margin-bottom: 0;
    }
    .surface-card:hover {
      border-color: var(--border-hi);
    }
    .surface-top {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      margin-bottom: 5px;
    }
    .surface-name {
      font-size: 13px;
      font-weight: 700;
      color: var(--text-0);
    }
    .surface-meta {
      font-size: 11.5px;
      color: var(--text-2);
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      margin-top: 6px;
      font-family: var(--font-mono);
    }

    /* Graph Canvas */
    .graph-toolbar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
      padding: 10px 14px;
      background: var(--bg-1);
      border-bottom: 1px solid var(--border);
    }
    .graph-canvas-wrap {
      position: relative;
      width: 100%;
      height: 540px;
      background: radial-gradient(circle at center, #0f172a 0%, #060911 100%);
      overflow: hidden;
    }
    #kg-canvas {
      width: 100%;
      height: 100%;
      cursor: grab;
      display: block;
    }
    #kg-canvas:active {
      cursor: grabbing;
    }
    .graph-legend {
      position: absolute;
      bottom: 12px;
      left: 12px;
      background: rgba(11, 17, 32, 0.88);
      border: 1px solid var(--border-hi);
      border-radius: 8px;
      padding: 8px 12px;
      font-size: 11px;
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      pointer-events: none;
    }
    .legend-item {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      color: var(--text-1);
    }
    .legend-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
    }
    .node-inspector {
      border-top: 1px solid var(--border);
      background: var(--bg-1);
      padding: 14px 16px;
    }

    /* Memory Types & Content Explorer Module */
    .type-cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(230px, 1fr));
      gap: 14px;
      margin-bottom: 16px;
    }
    .type-stat-card {
      background: linear-gradient(180deg, rgba(30, 41, 59, 0.5) 0%, rgba(15, 23, 42, 0.8) 100%);
      border: 1px solid var(--border-hi);
      border-radius: 12px;
      padding: 16px;
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .type-stat-card:hover, .type-stat-card.active {
      border-color: var(--cyan);
      box-shadow: 0 0 20px var(--cyan-glow);
    }
    .type-stat-num {
      font-size: 26px;
      font-weight: 800;
      font-family: var(--font-mono);
      margin: 6px 0 4px;
    }

    /* Tables */
    .data-table-wrap {
      overflow-x: auto;
    }
    table.data-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12.5px;
    }
    table.data-table th, table.data-table td {
      padding: 10px 12px;
      text-align: left;
      border-bottom: 1px solid var(--border);
    }
    table.data-table th {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-2);
      background: rgba(11, 17, 32, 0.6);
    }
    table.data-table tr:hover td {
      background: rgba(255, 255, 255, 0.025);
    }

    /* Memory Explorer Cards */
    .filter-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      margin-bottom: 14px;
    }
    .pill-group {
      display: flex;
      flex-wrap: wrap;
      gap: 6px;
    }
    .filter-pill {
      padding: 5px 11px;
      border-radius: 999px;
      font-size: 11.5px;
      font-weight: 600;
      background: var(--bg-1);
      border: 1px solid var(--border-hi);
      color: var(--text-2);
      cursor: pointer;
      transition: all 0.15s ease;
    }
    .filter-pill:hover {
      color: var(--text-0);
    }
    .filter-pill.active {
      background: var(--cyan-glow);
      color: #22d3ee;
      border-color: var(--cyan);
    }

    .memories-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
      gap: 14px;
    }
    .memory-card {
      background: var(--bg-1);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 14px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 10px;
      transition: border-color 0.15s ease;
    }
    .memory-card:hover {
      border-color: var(--cyan);
    }
    .memory-title {
      font-size: 14px;
      font-weight: 700;
      color: var(--text-0);
      margin-top: 6px;
    }
    .memory-preview {
      font-size: 12px;
      color: var(--text-1);
      background: var(--bg-0);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 10px;
      font-family: var(--font-mono);
      max-height: 150px;
      overflow-y: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }

    /* Diff Boxes */
    .diff-box {
      font-family: var(--font-mono);
      font-size: 11.5px;
      border-radius: 8px;
      padding: 8px 10px;
      margin-top: 6px;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 160px;
      overflow-y: auto;
    }
    .diff-old {
      background: rgba(244, 63, 94, 0.08);
      border: 1px solid rgba(244, 63, 94, 0.3);
      color: #fda4af;
    }
    .diff-new {
      background: rgba(16, 185, 129, 0.08);
      border: 1px solid rgba(16, 185, 129, 0.3);
      color: #6ee7b7;
    }

    /* Modal for Full Memory Inspection */
    #memory-modal {
      position: fixed;
      inset: 0;
      z-index: 5000;
      background: rgba(6, 9, 17, 0.82);
      backdrop-filter: blur(8px);
      display: none;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    #memory-modal.open {
      display: flex;
    }
    .modal-card {
      width: 100%;
      max-width: 820px;
      max-height: 88vh;
      background: var(--bg-2);
      border: 1px solid var(--border-hi);
      border-radius: 14px;
      display: flex;
      flex-direction: column;
      overflow: hidden;
      box-shadow: 0 25px 60px rgba(0, 0, 0, 0.7);
    }
    .modal-body {
      padding: 18px;
      overflow-y: auto;
      font-size: 13px;
    }
    pre.code-block {
      background: var(--bg-0);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px;
      font-family: var(--font-mono);
      font-size: 12px;
      color: var(--text-1);
      white-space: pre-wrap;
      word-break: break-word;
      overflow-x: auto;
    }
  </style>
</head>
<body>

  <!-- OPTION A: BROWSER SESSION AUTH OVERLAY (Zero Secrets in HTML) -->
  <div id="auth-overlay">
    <div class="auth-card">
      <div class="auth-logo">
        <span>🛡️ Zero-Trust Browser Session Auth</span>
      </div>
      <div class="auth-title">Gemini Brain Cognitive NOC</div>
      <div class="auth-subtitle">
        Authenticate directly against <code>https://brain.${primaryDomain}</code>. Your Bearer token is never embedded in page source and is sent strictly via HTTP <code>Authorization</code> headers.
      </div>

      <div id="auth-error" class="auth-error"></div>

      <form id="auth-form" onsubmit="handleAuthSubmit(event); return false;">
        <div class="form-group">
          <label class="form-label" for="token-input">MCP_BEARER_TOKEN</label>
          <input
            id="token-input"
            type="password"
            class="form-input"
            placeholder="Paste your MCP_BEARER_TOKEN..."
            autocomplete="off"
            required
          />
        </div>

        <div class="form-group">
          <label class="form-label" for="storage-mode">Browser Persistence Scope</label>
          <select id="storage-mode" class="form-select">
            <option value="local">Remember in Browser (localStorage)</option>
            <option value="session">Current Tab Session Only (sessionStorage)</option>
          </select>
        </div>

        <div class="auth-helper">
          <div>💡 <strong>Need your token from Windows 11 PowerShell?</strong> Run:</div>
          <code>(Get-Content C:\\Users\\simon\\Workspaces\\gemini-brain\\.dev.vars | Where-Object { $_ -match '^MCP_BEARER_TOKEN=' }) -replace '^MCP_BEARER_TOKEN=','' | Set-Clipboard</code>
        </div>

        <button type="submit" id="auth-submit-btn" class="btn btn-primary" style="width: 100%; padding: 11px;">
          🔓 Unlock Cognitive NOC Dashboard
        </button>
      </form>
    </div>
  </div>

  <!-- MEMORY DETAIL MODAL -->
  <div id="memory-modal">
    <div class="modal-card">
      <div class="panel-header">
        <div class="panel-title" id="modal-title">Memory Record Inspector</div>
        <button class="btn btn-sm" onclick="closeMemoryModal()">✕ Close</button>
      </div>
      <div class="modal-body" id="modal-content"></div>
    </div>
  </div>

  <!-- TOP TELEMETRY PULSE HEADER -->
  <header class="top-header">
    <div class="brand-group">
      <div class="pulse-dot" id="status-dot"></div>
      <div>
        <div class="brand-title">🧠 Gemini Brain Cognitive NOC <span class="badge badge-cyan" style="font-size:10px; vertical-align:middle; margin-left:6px;">v${version}</span></div>
        <div class="brand-sub">brain.${primaryDomain} • BrainMemoryDO + D1 Archive + Dual Vectorize</div>
      </div>
    </div>

    <div class="kpi-strip">
      <div class="kpi-pill">
        <span class="label">Active Memories</span>
        <span class="val" id="kpi-memories">—</span>
      </div>
      <div class="kpi-pill">
        <span class="label">Knowledge Graph</span>
        <span class="val" id="kpi-graph">—</span>
      </div>
      <div class="kpi-pill">
        <span class="label">Active ADRs</span>
        <span class="val" id="kpi-adrs">—</span>
      </div>
      <div class="kpi-pill">
        <span class="label">D1 Deep Archive</span>
        <span class="val" id="kpi-d1">—</span>
      </div>
      <div class="kpi-pill" style="cursor: pointer;" onclick="switchTab('tab-sleep', document.querySelector('[data-tab=tab-sleep]'))">
        <span class="label">Governance Conflicts</span>
        <span class="val" id="kpi-conflicts">—</span>
      </div>
      <div class="kpi-pill">
        <span class="label">Next 03:00 AM Sleep Cycle</span>
        <span class="val" style="color: var(--cyan);" id="kpi-alarm-countdown">—</span>
      </div>
    </div>

    <div style="display: flex; align-items: center; gap: 8px;">
      <button class="btn btn-sm btn-emerald" onclick="refreshDashboard()" id="btn-refresh">
        ↻ Refresh Telemetry
      </button>
      <button class="btn btn-sm btn-amber" onclick="triggerConsolidationNow()" id="btn-consolidate">
        🌙 Run Sleep Cycle Now
      </button>
      <button class="btn btn-sm" onclick="triggerReindexNow()" id="btn-reindex">
        ⚡ Reindex FTS5/Vectors
      </button>
      <button class="btn btn-sm btn-rose" onclick="lockSession()">
        🔒 Lock Session
      </button>
    </div>
  </header>

  <!-- NAVIGATION BAR -->
  <nav class="nav-bar">
    <div class="tab-group">
      <button class="tab-btn active" data-tab="tab-noc" onclick="switchTab('tab-noc', this)">
        🕸️ 1. NOC Topology, Surfaces & Knowledge Graph
      </button>
      <button class="tab-btn" data-tab="tab-memories" onclick="switchTab('tab-memories', this)">
        🗂️ 2. Memory Types Status & Content by Namespace
      </button>
      <button class="tab-btn" data-tab="tab-sleep" onclick="switchTab('tab-sleep', this)">
        🌙 3. Sleep Cycle, Governance Watchdog, ADRs & Diff Rollback
      </button>
    </div>
    <div style="font-size: 11.5px; color: var(--text-2); font-family: var(--font-mono);" id="last-sync-label">
      Waiting for session authentication...
    </div>
  </nav>

  <!-- =========================================================================
       TAB 1: NOC TOPOLOGY, SURFACES, DATABASES, KNOWLEDGE GRAPH & 4-WAY RRF
       ========================================================================= -->
  <section id="tab-noc" class="view-section active">
    <div class="noc-grid">
      <!-- LEFT COLUMN: SURFACES & DATABASES -->
      <div>
        <div class="panel">
          <div class="panel-header">
            <div class="panel-title">🖥️ Connected Client Surfaces</div>
            <span class="badge badge-cyan" id="surfaces-count-badge">6 Surfaces</span>
          </div>
          <div class="panel-body" id="surfaces-container">
            <div style="color: var(--text-2); font-size: 12px;">Loading surface telemetry...</div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-header">
            <div class="panel-title">🗄️ Federated Databases & Indexes</div>
            <span class="badge badge-emerald">4-Way RRF</span>
          </div>
          <div class="panel-body" id="databases-container">
            <div style="color: var(--text-2); font-size: 12px;">Loading storage engines...</div>
          </div>
        </div>
      </div>

      <!-- CENTER COLUMN: INTERACTIVE FORCE-DIRECTED KNOWLEDGE GRAPH -->
      <div>
        <div class="panel">
          <div class="panel-header">
            <div class="panel-title">🕸️ Interactive Knowledge Graph (PageRank Centrality Sizing)</div>
            <div style="display: flex; gap: 6px; align-items: center;">
              <span class="badge badge-violet" id="graph-stats-badge">0 Nodes • 0 Edges</span>
              <button class="btn btn-sm" onclick="resetGraphCamera()">⌖ Center Graph</button>
            </div>
          </div>

          <div class="graph-toolbar">
            <div style="display: flex; gap: 8px; flex-wrap: wrap; align-items: center;">
              <select id="graph-ns-filter" class="form-select" style="width: auto; padding: 5px 10px; font-size: 12px;" onchange="applyGraphFilter()">
                <option value="all">All Namespaces</option>
              </select>
              <input
                id="graph-search-input"
                type="text"
                class="form-input"
                style="width: 210px; padding: 5px 10px; font-size: 12px;"
                placeholder="Highlight node (e.g. rpi5, d1)..."
                oninput="applyGraphFilter()"
              />
            </div>
            <div style="font-size: 11px; color: var(--text-2);">
              Drag nodes • Scroll to zoom • Click node to inspect triples
            </div>
          </div>

          <div class="graph-canvas-wrap">
            <canvas id="kg-canvas"></canvas>
            <div class="graph-legend">
              <span class="legend-item"><span class="legend-dot" style="background:#06b6d4"></span> global</span>
              <span class="legend-item"><span class="legend-dot" style="background:#10b981"></span> tsimon.me</span>
              <span class="legend-item"><span class="legend-dot" style="background:#8b5cf6"></span> homelab / rpi5</span>
              <span class="legend-item"><span class="legend-dot" style="background:#f59e0b"></span> minkalab.net</span>
              <span class="legend-item"><span class="legend-dot" style="background:#f43f5e"></span> ai-research / career</span>
            </div>
          </div>

          <div class="node-inspector" id="node-inspector">
            <div style="font-size: 12px; color: var(--text-2);">
              👆 Click any entity node in the Knowledge Graph above (such as <code>node:rpi5</code> or <code>domain:tsimon.me</code>) to inspect its PageRank centrality, incoming/outgoing relational edges, and linked memories.
            </div>
          </div>
        </div>
      </div>

      <!-- RIGHT COLUMN: 4-WAY RRF SEARCH PLAYGROUND -->
      <div class="noc-right-col">
        <div class="panel">
          <div class="panel-header">
            <div class="panel-title">🔍 4-Way RRF Recall Inspector</div>
            <span class="badge badge-cyan">bge-m3 + D1 + KG</span>
          </div>
          <div class="panel-body">
            <form id="recall-form" onsubmit="runRecallPlayground(event)">
              <div class="form-group">
                <label class="form-label">Search Query</label>
                <input
                  id="recall-query"
                  type="text"
                  class="form-input"
                  value="Raspberry Pi 5 Qdrant architecture and Cloudflare federation"
                  placeholder="Enter technical topic or entity..."
                  required
                />
              </div>

              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px;">
                <div>
                  <label class="form-label">Namespace Scope</label>
                  <select id="recall-namespace" class="form-select">
                    <option value="global">global (All)</option>
                    <option value="tsimon.me">tsimon.me</option>
                    <option value="homelab">homelab</option>
                    <option value="minkalab.net">minkalab.net</option>
                    <option value="ai-research">ai-research</option>
                    <option value="career">career</option>
                  </select>
                </div>
                <div>
                  <label class="form-label">Token Budget: <span id="budget-val">2000</span></label>
                  <input
                    id="recall-budget"
                    type="range"
                    min="300"
                    max="6000"
                    step="100"
                    value="2000"
                    style="width: 100%; margin-top: 8px;"
                    oninput="document.getElementById('budget-val').textContent = this.value"
                  />
                </div>
              </div>

              <button type="submit" id="recall-submit-btn" class="btn btn-primary" style="width: 100%;">
                ⚡ Execute 4-Way Federated Recall
              </button>
            </form>

            <div id="recall-results-container" style="margin-top: 16px;">
              <div style="font-size: 12px; color: var(--text-2);">
                Run a test query above to inspect how <strong>Brain FTS5</strong>, <strong>Brain Vectorize (1024d)</strong>, <strong>D1 Archive FTS5</strong>, <strong>KB Vectorize (768d)</strong>, and <strong>1-Hop Knowledge Graph Expansion</strong> fuse and pack into your token budget.
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- =========================================================================
       TAB 2: MEMORY TYPES STATUS & CONTENT EXPLORER BY NAMESPACE
       ========================================================================= -->
  <section id="tab-memories" class="view-section">
    <!-- Top Summary Cards by Memory Type -->
    <div class="type-cards-grid" id="memory-type-cards"></div>

    <!-- Namespace x Memory Type Breakdown Matrix -->
    <div class="panel">
      <div class="panel-header">
        <div class="panel-title">📊 Memory Types Status Breakdown by Namespace</div>
        <span class="badge badge-cyan">Click any row/type to filter content below</span>
      </div>
      <div class="panel-body data-table-wrap">
        <table class="data-table" id="ns-type-matrix-table">
          <thead>
            <tr>
              <th>Namespace</th>
              <th>Semantic Memories</th>
              <th>Procedural Memories</th>
              <th>Episodic Summaries (03:00 AM Digests)</th>
              <th>Active ADRs (Decisions)</th>
              <th>Total Tokens Stored</th>
              <th>Avg Importance</th>
              <th>Synaptic Recalls</th>
              <th>Action</th>
            </tr>
          </thead>
          <tbody id="ns-type-matrix-body"></tbody>
        </table>
      </div>
    </div>

    <!-- Interactive Memory Content Explorer -->
    <div class="panel">
      <div class="panel-header">
        <div class="panel-title">🗂️ Memory Content Explorer by Namespace & Type</div>
        <span class="badge badge-emerald" id="explorer-count-badge">0 Memories</span>
      </div>
      <div class="panel-body">
        <div class="filter-bar">
          <div>
            <div style="font-size: 11px; color: var(--text-2); margin-bottom: 5px; font-weight: 600;">FILTER BY NAMESPACE:</div>
            <div class="pill-group" id="explorer-ns-pills"></div>
          </div>

          <div>
            <div style="font-size: 11px; color: var(--text-2); margin-bottom: 5px; font-weight: 600;">FILTER BY MEMORY TYPE:</div>
            <div class="pill-group" id="explorer-type-pills">
              <button class="filter-pill active" data-type="all" onclick="setExplorerType('all')">All Types</button>
              <button class="filter-pill" data-type="semantic" onclick="setExplorerType('semantic')">📘 semantic</button>
              <button class="filter-pill" data-type="procedural" onclick="setExplorerType('procedural')">⚙️ procedural</button>
              <button class="filter-pill" data-type="episodic_summary" onclick="setExplorerType('episodic_summary')">🌙 episodic_summary</button>
            </div>
          </div>

          <div style="min-width: 260px;">
            <div style="font-size: 11px; color: var(--text-2); margin-bottom: 5px; font-weight: 600;">SEARCH CONTENT OR ID:</div>
            <input
              id="explorer-search"
              type="text"
              class="form-input"
              style="padding: 6px 10px; font-size: 12px;"
              placeholder="Filter by keyword, title, or memory ID..."
              oninput="renderMemoryExplorer()"
            />
          </div>
        </div>

        <div class="memories-grid" id="memories-explorer-grid"></div>
      </div>
    </div>
  </section>

  <!-- =========================================================================
       TAB 3: NOCTURNAL SLEEP CYCLE, GOVERNANCE WATCHDOG, ADRS & MUTATION DIFFS
       ========================================================================= -->
  <section id="tab-sleep" class="view-section">
    <!-- Active Memory Governance & Semantic Contradiction Triage Panel -->
    <div class="panel" style="margin-bottom: 16px;">
      <div class="panel-header">
        <div class="panel-title">🛡️ Active Memory Governance & Semantic Contradiction Triage (memory_conflicts)</div>
        <div style="display: flex; gap: 8px; align-items: center;">
          <span class="badge badge-amber" id="conflicts-count-badge">0 Pending</span>
          <button class="btn btn-sm btn-primary" onclick="triggerConflictAuditNow()" id="btn-audit-conflicts">
            🔍 Run Contradiction Audit Now
          </button>
        </div>
      </div>
      <div class="panel-body" id="conflicts-container" style="max-height: 460px; overflow-y: auto;"></div>
    </div>

    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(460px, 1fr)); gap: 16px;">
      <!-- Pending Episodic Scratchpad Logs -->
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">📝 Hippocampus Scratchpad (Episodic Logs Queue)</div>
          <span class="badge badge-amber" id="pending-episodic-badge">0 Pending</span>
        </div>
        <div class="panel-body" id="episodic-logs-container" style="max-height: 520px; overflow-y: auto;"></div>
      </div>

      <!-- Nocturnal Consolidation Runs (Llama 3.3 70B Digests) -->
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">🌙 03:00 AM Nocturnal Consolidation Runs (Llama 3.3 70B)</div>
          <span class="badge badge-violet" id="consolidation-runs-badge">0 Runs</span>
        </div>
        <div class="panel-body" id="consolidation-runs-container" style="max-height: 520px; overflow-y: auto;"></div>
      </div>
    </div>

    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(460px, 1fr)); gap: 16px;">
      <!-- Mutation Audit Trail & 1-Click Rollback -->
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">🔄 Mutation Audit Stream (Before/After Diff & Rollback)</div>
          <span class="badge badge-cyan" id="mutations-count-badge">0 Mutations</span>
        </div>
        <div class="panel-body" id="mutations-container" style="max-height: 600px; overflow-y: auto;"></div>
      </div>

      <!-- Active Architecture Decision Records (ADRs) -->
      <div class="panel">
        <div class="panel-header">
          <div class="panel-title">📜 Active Architecture Decision Records (ADRs)</div>
          <span class="badge badge-emerald" id="adrs-count-badge">0 Active</span>
        </div>
        <div class="panel-body" id="adrs-container" style="max-height: 600px; overflow-y: auto;"></div>
      </div>
    </div>
  </section>

  <script>
    // =========================================================================
    // STATE & AUTHENTICATION (OPTION A: BROWSER SESSION AUTH)
    // =========================================================================
    const STORAGE_KEY = "gemini_brain_noc_bearer_token";
    let SNAPSHOT = null;
    let EXPLORER_NS = "all";
    let EXPLORER_TYPE = "all";
    let SELECTED_NODE = null;

    function normalizeToken(raw) {
      if (!raw) return "";
      return String(raw)
        .trim()
        .replace(/^MCP_BEARER_TOKEN\s*=\s*/i, "")
        .replace(/^Bearer\s+/i, "")
        .replace(/^["']+|["']+$/g, "")
        .trim();
    }

    function getStoredToken() {
      return normalizeToken(sessionStorage.getItem(STORAGE_KEY) || localStorage.getItem(STORAGE_KEY) || "");
    }

    function saveToken(token, mode) {
      const clean = normalizeToken(token);
      sessionStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(STORAGE_KEY);
      if (mode === "session") {
        sessionStorage.setItem(STORAGE_KEY, clean);
      } else {
        localStorage.setItem(STORAGE_KEY, clean);
      }
    }

    function lockSession() {
      sessionStorage.removeItem(STORAGE_KEY);
      localStorage.removeItem(STORAGE_KEY);
      SNAPSHOT = null;
      document.getElementById("token-input").value = "";
      document.getElementById("auth-overlay").classList.remove("hidden");
      document.getElementById("last-sync-label").textContent = "Session locked.";
    }

    async function apiNocCall(nocAction, payload = {}) {
      const token = getStoredToken();
      if (!token) {
        throw new Error("Missing Bearer token");
      }
      const res = await fetch("/mcp?noc=" + encodeURIComponent(nocAction), {
        method: "POST",
        headers: {
          "Authorization": "Bearer " + token,
          "X-Brain-Token": token,
          "X-Brain-Noc-Action": nocAction,
          "Content-Type": "application/json",
          "Accept": "application/json"
        },
        body: JSON.stringify(Object.assign({ nocAction, _token: token }, payload))
      });

      if (res.status === 401 || res.status === 403) {
        lockSession();
        throw new Error(
          "HTTP " +
            res.status +
            " blocked by Edge/Auth. Try opening https://brain.tsimon.me/mcp?ui=1 or running .\\brain-dashboard.ps1 locally."
        );
      }

      if (!res.ok) {
        const errText = await res.text();
        let parsedError = errText;
        try {
          const parsed = JSON.parse(errText);
          if (parsed && typeof parsed.error === "string" && parsed.error.trim()) {
            parsedError = parsed.error;
          }
        } catch {}
        throw new Error("HTTP " + res.status + ": " + parsedError);
      }

      const data = await res.json();
      if (data && data.authError) {
        lockSession();
        throw new Error(data.authError);
      }
      if (data && data.ok === false && data.error) {
        throw new Error(data.error);
      }
      return data;
    }

    async function handleAuthSubmit(e) {
      if (e) e.preventDefault();
      const rawToken = document.getElementById("token-input").value;
      const token = normalizeToken(rawToken);
      const mode = document.getElementById("storage-mode").value;
      const errBox = document.getElementById("auth-error");
      const btn = document.getElementById("auth-submit-btn");

      errBox.style.display = "none";
      btn.disabled = true;
      btn.textContent = "Verifying token with BrainMemoryDO...";

      try {
        saveToken(token, mode);
        await refreshDashboard();
        document.getElementById("auth-overlay").classList.add("hidden");
        try {
          const cleanUrl = new URL(window.location.href);
          cleanUrl.searchParams.delete("reset");
          cleanUrl.searchParams.delete("logout");
          if (cleanUrl.pathname === "/mcp" && !cleanUrl.searchParams.has("ui")) {
            cleanUrl.searchParams.set("ui", "1");
          }
          window.history.replaceState({}, "", cleanUrl.pathname + cleanUrl.search);
        } catch {}
      } catch (err) {
        sessionStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(STORAGE_KEY);
        errBox.textContent = err.message || "Authentication failed.";
        errBox.style.display = "block";
      } finally {
        btn.disabled = false;
        btn.textContent = "🔓 Unlock Cognitive NOC Dashboard";
      }
      return false;
    }

    function switchTab(tabId, btnEl) {
      document.querySelectorAll(".view-section").forEach((s) => s.classList.remove("active"));
      document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
      document.getElementById(tabId).classList.add("active");
      if (btnEl) btnEl.classList.add("active");
      if (tabId === "tab-noc") {
        resizeCanvas();
      }
    }

    function escapeHtml(str) {
      if (str === null || str === undefined) return "";
      return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    }

    function formatRelativeTime(unixSec) {
      if (!unixSec) return "Never";
      const diffSec = Math.max(0, Math.floor(Date.now() / 1000) - Number(unixSec));
      if (diffSec < 60) return diffSec + "s ago";
      if (diffSec < 3600) return Math.floor(diffSec / 60) + "m ago";
      if (diffSec < 86400) return Math.floor(diffSec / 3600) + "h ago";
      return Math.floor(diffSec / 86400) + "d ago";
    }

    function formatIsoShort(unixSec) {
      if (!unixSec) return "—";
      return new Date(Number(unixSec) * 1000).toISOString().replace("T", " ").slice(0, 19) + " UTC";
    }

    // =========================================================================
    // DASHBOARD HYDRATION & RENDERING
    // =========================================================================
    async function refreshDashboard() {
      const btn = document.getElementById("btn-refresh");
      btn.disabled = true;
      btn.textContent = "↻ Syncing...";
      try {
        const data = await apiNocCall("dashboard", { limit: 250 });
        SNAPSHOT = data;
        renderTopKpis(data);
        renderSurfacesAndDatabases(data);
        initKnowledgeGraph(data.graph);
        renderMemoryTypesAndExplorer(data);
        renderSleepCycleAndAudit(data);
        document.getElementById("last-sync-label").textContent =
          "Last synced: " + new Date().toLocaleTimeString();
      } finally {
        btn.disabled = false;
        btn.textContent = "↻ Refresh Telemetry";
      }
    }

    function renderTopKpis(data) {
      const t = data.telemetry;
      document.getElementById("kpi-memories").textContent =
        t.activeMemories.toLocaleString() + " (" + (t.totalTokensStored || 0).toLocaleString() + " tok)";
      document.getElementById("kpi-graph").textContent =
        t.activeEntities.toLocaleString() + " Nodes • " + t.activeEdges.toLocaleString() + " Edges";
      document.getElementById("kpi-adrs").textContent = t.activeDecisions.toLocaleString();
      document.getElementById("kpi-d1").textContent =
        (t.d1ArchiveCount || 14422).toLocaleString() + " Docs";
      const pendingConf = Number(t.pendingConflicts || 0);
      const confEl = document.getElementById("kpi-conflicts");
      if (confEl) {
        confEl.textContent = pendingConf === 0 ? "0 Pending ✓" : pendingConf + " Pending ⚠️";
        confEl.style.color = pendingConf === 0 ? "var(--emerald)" : "var(--amber)";
      }
    }

    // Live countdown timer to 03:00 AM AST / 07:00 UTC
    setInterval(() => {
      if (!SNAPSHOT || !SNAPSHOT.telemetry || !SNAPSHOT.telemetry.nextAlarmIso) return;
      const targetMs = new Date(SNAPSHOT.telemetry.nextAlarmIso).getTime();
      const diffMs = Math.max(0, targetMs - Date.now());
      const hrs = Math.floor(diffMs / 3600000);
      const mins = Math.floor((diffMs % 3600000) / 60000);
      const secs = Math.floor((diffMs % 60000) / 1000);
      const pending = SNAPSHOT.telemetry.pendingEpisodicLogs || 0;
      document.getElementById("kpi-alarm-countdown").textContent =
        hrs + "h " + mins + "m " + secs + "s (" + pending + " queued)";
    }, 1000);

    // =========================================================================
    // PANEL 1: SURFACES & DATABASES MATRIX
    // =========================================================================
    function renderSurfacesAndDatabases(data) {
      const mutMap = new Map();
      (data.surfaces.mutationClients || []).forEach((c) => mutMap.set(c.client_id, c));
      const epiMap = new Map();
      (data.surfaces.episodicClients || []).forEach((c) => epiMap.set(c.client_id, c));

      function aggregateSurface(matchFn) {
        let muts = 0, epis = 0, pending = 0, lastTs = 0;
        for (const [cid, row] of mutMap.entries()) {
          if (matchFn(cid)) {
            muts += row.mutations_count;
            if (row.last_mutation_at > lastTs) lastTs = row.last_mutation_at;
          }
        }
        for (const [cid, row] of epiMap.entries()) {
          if (matchFn(cid)) {
            epis += row.episodic_count;
            pending += row.pending_count || 0;
            if (row.last_episodic_at > lastTs) lastTs = row.last_episodic_at;
          }
        }
        return { muts, epis, pending, lastTs };
      }

      const isRpiCli = (c) => {
        const l = c.toLowerCase();
        return (l.includes("rpi5") || l.includes("rpi")) && (l.includes("cli") || l.includes("antigravity"));
      };
      const agStats = aggregateSurface((c) => {
        const l = c.toLowerCase();
        return l.includes("antigravity") && !isRpiCli(c);
      });
      const cliStats = aggregateSurface((c) => {
        const l = c.toLowerCase();
        return !isRpiCli(c) && !l.includes("antigravity") && (l.includes("gemini-cli") || l.includes("cli"));
      });
      const rpiCliStats = aggregateSurface(isRpiCli);
      const webStats = aggregateSurface((c) => c.toLowerCase().includes("web"));
      const rpiStats = aggregateSurface((c) => {
        const l = c.toLowerCase();
        return !isRpiCli(c) && (l.includes("rpi5") || l.includes("qdrant"));
      });
      const sleepStats = aggregateSurface((c) => {
        const l = c.toLowerCase();
        return l.includes("nocturnal") || l.includes("consolidat");
      });

      const rpiPreserved = data.surfaces.rpi5Preserved || { preservedEntities: 0, preservedActiveEdges: 0 };

      const surfaceCards = [
        {
          name: "💻 Google Antigravity IDE / 2.0",
          clientId: "antigravity-win11",
          badge: "badge-emerald",
          status: "CONNECTED (MCP v2)",
          desc: "Primary Windows 11 IDE & agentic workspace with automatic episodic checkpointing.",
          muts: agStats.muts,
          epis: agStats.epis,
          lastTs: agStats.lastTs
        },
        {
          name: "🍓 Raspberry Pi 5 Home Lab (node:rpi5)",
          clientId: "rpi5-debian13-daemon / qdrant",
          badge: rpiPreserved.rpiSyncEnabled === false ? "badge-amber" : "badge-emerald",
          status: rpiPreserved.rpiSyncEnabled === false ? "OFFLINE • GRAPH PRESERVED" : "CONNECTED • ACTIVE (EDGE SYNC)",
          desc: (rpiPreserved.rpiSyncEnabled === false
            ? "RPI_SYNC_ENABLED=false while hardware is offline. "
            : "RPI_SYNC_ENABLED=true • Debian 13 AST/Markdown watcher & Qdrant federation online. ") +
                rpiPreserved.preservedEntities + " RPi5/Qdrant entities & " +
                rpiPreserved.preservedActiveEdges + " active edges linked (valid_until = NULL).",
          muts: rpiStats.muts,
          epis: rpiStats.epis,
          lastTs: rpiStats.lastTs
        },
        {
          name: "🍓⌨️ Raspberry Pi 5 Gemini CLI",
          clientId: "antigravity-cli-rpi5",
          badge: "badge-cyan",
          status: "CONNECTED (MCP v2)",
          desc: "Interactive Antigravity / Gemini CLI terminal on Raspberry Pi 5 (node:rpi5) with X-Brain-Client-Id & session sync.",
          muts: rpiCliStats.muts,
          epis: rpiCliStats.epis,
          lastTs: rpiCliStats.lastTs
        },
        {
          name: "🌐 Gemini Web App Bridge",
          clientId: "gemini-web-architect",
          badge: "badge-violet",
          status: "OAUTH 2.1 + BRIDGE",
          desc: "Native Gemini Web OAuth 2.1 MCP connection & clipboard checkpoint hydrator.",
          muts: webStats.muts,
          epis: webStats.epis,
          lastTs: webStats.lastTs
        },
        {
          name: "🌙 Nocturnal Dreamer (Llama 3.3 70B)",
          clientId: "nocturnal-consolidator",
          badge: "badge-cyan",
          status: "03:00 AM ALARM SCHEDULED",
          desc: "Cloudflare Durable Object alarm() consolidating episodic logs & PageRank.",
          muts: sleepStats.muts,
          epis: (data.sleepCycle.consolidationRuns || []).length,
          lastTs: sleepStats.lastTs
        },
        {
          name: "⌨️ Gemini CLI Terminal (Win11)",
          clientId: "gemini-cli-win11",
          badge: "badge-cyan",
          status: "CONNECTED (MCP v2)",
          desc: "Direct Windows 11 shell & CLI workflows sharing real-time BrainMemoryDO state.",
          muts: cliStats.muts,
          epis: cliStats.epis,
          lastTs: cliStats.lastTs
        }
      ];

      document.getElementById("surfaces-count-badge").textContent = surfaceCards.length + " Surfaces";
      document.getElementById("surfaces-container").innerHTML = surfaceCards
        .map(
          (s) => \`
          <div class="surface-card">
            <div class="surface-top">
              <span class="surface-name">\${escapeHtml(s.name)}</span>
              <span class="badge \${s.badge}">\${escapeHtml(s.status)}</span>
            </div>
            <div style="font-size: 10.5px; color: var(--cyan); font-family: var(--font-mono); margin-bottom: 4px;">
              clientId: \${escapeHtml(s.clientId)}
            </div>
            <div style="font-size: 11.5px; color: var(--text-2);">\${escapeHtml(s.desc)}</div>
            <div class="surface-meta">
              <span>Mutations: <strong>\${s.muts}</strong></span>
              <span>Episodic Events: <strong>\${s.epis}</strong></span>
              <span>Last Activity: <strong>\${formatRelativeTime(s.lastTs)}</strong></span>
            </div>
          </div>
        \`
        )
        .join("");

      const dbs = data.databases || [];
      document.getElementById("databases-container").innerHTML = dbs
        .map((db) => {
          const isOffline = db.status.includes("OFFLINE");
          const badgeCls = isOffline ? "badge-amber" : "badge-emerald";
          return \`
            <div class="surface-card">
              <div class="surface-top">
                <span class="surface-name">\${escapeHtml(db.name)}</span>
                <span class="badge \${badgeCls}">\${escapeHtml(db.status)}</span>
              </div>
              <div style="font-size: 11px; color: var(--cyan); font-family: var(--font-mono); margin-bottom: 4px;">
                \${escapeHtml(db.engine)}
              </div>
              <div style="font-size: 11.5px; color: var(--text-2);">\${escapeHtml(db.details)}</div>
            </div>
          \`;
        })
        .join("");
    }

    // =========================================================================
    // PANEL 2: INTERACTIVE 2D FORCE-DIRECTED KNOWLEDGE GRAPH
    // =========================================================================
    let GRAPH_NODES = [];
    let GRAPH_EDGES = [];
    let CAM = { x: 0, y: 0, zoom: 1 };
    let DRAG_NODE = null;
    let IS_PANNING = false;
    let PAN_START = { x: 0, y: 0 };
    let ANIM_FRAME = null;

    function getNamespaceColor(ns) {
      const n = (ns || "global").toLowerCase();
      if (n === "tsimon.me") return "#10b981";
      if (n === "homelab") return "#8b5cf6";
      if (n === "minkalab.net") return "#f59e0b";
      if (n === "ai-research" || n === "career") return "#f43f5e";
      return "#06b6d4";
    }

    function initKnowledgeGraph(graphData) {
      const rawNodes = (graphData && graphData.nodes) || [];
      const rawEdges = (graphData && graphData.edges) || [];

      document.getElementById("graph-stats-badge").textContent =
        rawNodes.length + " Nodes • " + rawEdges.length + " Active Edges";

      // Populate namespace dropdown in graph toolbar
      const namespaces = Array.from(new Set(rawNodes.map((n) => n.namespace || "global"))).sort();
      const nsSelect = document.getElementById("graph-ns-filter");
      const currentVal = nsSelect.value || "all";
      nsSelect.innerHTML =
        '<option value="all">All Namespaces (' + rawNodes.length + ')</option>' +
        namespaces
          .map((ns) => '<option value="' + escapeHtml(ns) + '">' + escapeHtml(ns) + '</option>')
          .join("");
      nsSelect.value = namespaces.includes(currentVal) ? currentVal : "all";

      const canvas = document.getElementById("kg-canvas");
      const rect = canvas.parentElement.getBoundingClientRect();
      canvas.width = rect.width || 800;
      canvas.height = rect.height || 540;

      const cx = canvas.width / 2;
      const cy = canvas.height / 2;

      const nodeMap = new Map();
      GRAPH_NODES = rawNodes.map((n, i) => {
        const angle = (i / Math.max(1, rawNodes.length)) * Math.PI * 2;
        const radius = 60 + (i % 7) * 32;
        const pr = Number(n.pagerank_score || 0.15);
        const obj = {
          ...n,
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius,
          vx: 0,
          vy: 0,
          r: Math.max(7, Math.min(22, 6 + pr * 18)),
          color: getNamespaceColor(n.namespace),
          visible: true,
          highlighted: false
        };
        nodeMap.set(n.entity_id, obj);
        return obj;
      });

      GRAPH_EDGES = rawEdges
        .map((e) => ({
          ...e,
          source: nodeMap.get(e.source_entity),
          target: nodeMap.get(e.target_entity)
        }))
        .filter((e) => e.source && e.target);

      applyGraphFilter();
      if (!ANIM_FRAME) {
        tickGraphPhysics();
      }
    }

    function applyGraphFilter() {
      const ns = document.getElementById("graph-ns-filter").value;
      const q = (document.getElementById("graph-search-input").value || "").trim().toLowerCase();

      GRAPH_NODES.forEach((n) => {
        const nsMatch = ns === "all" || n.namespace === ns;
        const qMatch =
          !q ||
          n.entity_id.toLowerCase().includes(q) ||
          (n.canonical_name || "").toLowerCase().includes(q) ||
          (n.entity_type || "").toLowerCase().includes(q);
        n.visible = nsMatch;
        n.highlighted = Boolean(q && qMatch);
      });
    }

    function resetGraphCamera() {
      CAM = { x: 0, y: 0, zoom: 1 };
    }

    function resizeCanvas() {
      const canvas = document.getElementById("kg-canvas");
      if (!canvas || !canvas.parentElement) return;
      const rect = canvas.parentElement.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        canvas.width = rect.width;
        canvas.height = rect.height;
      }
    }
    window.addEventListener("resize", resizeCanvas);

    function tickGraphPhysics() {
      const canvas = document.getElementById("kg-canvas");
      const ctx = canvas.getContext("2d");
      const w = canvas.width;
      const h = canvas.height;
      const cx = w / 2;
      const cy = h / 2;

      const visibleNodes = GRAPH_NODES.filter((n) => n.visible);

      // Repulsion between nodes
      for (let i = 0; i < visibleNodes.length; i++) {
        const a = visibleNodes[i];
        for (let j = i + 1; j < visibleNodes.length; j++) {
          const b = visibleNodes[j];
          let dx = b.x - a.x;
          let dy = b.y - a.y;
          let distSq = dx * dx + dy * dy;
          if (distSq < 1) distSq = 1;
          if (distSq < 36000) {
            const dist = Math.sqrt(distSq);
            const force = 420 / distSq;
            const fx = (dx / dist) * force;
            const fy = (dy / dist) * force;
            a.vx -= fx;
            a.vy -= fy;
            b.vx += fx;
            b.vy += fy;
          }
        }
      }

      // Spring attraction along edges
      for (const e of GRAPH_EDGES) {
        if (!e.source.visible || !e.target.visible) continue;
        const dx = e.target.x - e.source.x;
        const dy = e.target.y - e.source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 1;
        const targetDist = 115;
        const force = (dist - targetDist) * 0.008;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        e.source.vx += fx;
        e.source.vy += fy;
        e.target.vx -= fx;
        e.target.vy -= fy;
      }

      // Center gravity & velocity damping
      for (const n of visibleNodes) {
        if (n === DRAG_NODE) continue;
        n.vx += (cx - n.x) * 0.0018;
        n.vy += (cy - n.y) * 0.0018;
        n.vx *= 0.82;
        n.vy *= 0.82;
        n.x += n.vx;
        n.y += n.vy;
      }

      // Render Graph
      ctx.clearRect(0, 0, w, h);
      ctx.save();
      ctx.translate(w / 2 + CAM.x, h / 2 + CAM.y);
      ctx.scale(CAM.zoom, CAM.zoom);
      ctx.translate(-w / 2, -h / 2);

      // Draw edges
      for (const e of GRAPH_EDGES) {
        if (!e.source.visible || !e.target.visible) continue;
        const isSelectedEdge =
          SELECTED_NODE &&
          (e.source.entity_id === SELECTED_NODE.entity_id ||
            e.target.entity_id === SELECTED_NODE.entity_id);

        ctx.beginPath();
        ctx.moveTo(e.source.x, e.source.y);
        ctx.lineTo(e.target.x, e.target.y);
        ctx.strokeStyle = isSelectedEdge ? "#22d3ee" : "rgba(100, 116, 139, 0.28)";
        ctx.lineWidth = isSelectedEdge ? 2 : 1;
        ctx.stroke();

        if (isSelectedEdge || CAM.zoom > 1.35) {
          const mx = (e.source.x + e.target.x) / 2;
          const my = (e.source.y + e.target.y) / 2;
          ctx.fillStyle = isSelectedEdge ? "#22d3ee" : "#64748b";
          ctx.font = "9px JetBrains Mono, monospace";
          ctx.textAlign = "center";
          ctx.fillText(e.relation, mx, my - 3);
        }
      }

      // Draw nodes
      for (const n of visibleNodes) {
        const isSelected = SELECTED_NODE && SELECTED_NODE.entity_id === n.entity_id;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = n.color;
        ctx.fill();

        if (isSelected || n.highlighted) {
          ctx.lineWidth = 3;
          ctx.strokeStyle = isSelected ? "#ffffff" : "#fbbf24";
          ctx.stroke();
        } else {
          ctx.lineWidth = 1.2;
          ctx.strokeStyle = "rgba(15, 23, 42, 0.9)";
          ctx.stroke();
        }

        // Node label
        ctx.fillStyle = isSelected || n.highlighted ? "#ffffff" : "#cbd5e1";
        ctx.font = (isSelected ? "bold " : "") + "10.5px Inter, sans-serif";
        ctx.textAlign = "center";
        ctx.fillText(n.canonical_name || n.entity_id, n.x, n.y + n.r + 12);
      }

      ctx.restore();
      ANIM_FRAME = requestAnimationFrame(tickGraphPhysics);
    }

    // Canvas Mouse Interaction (Drag, Pan, Zoom, Click Node)
    (function setupCanvasEvents() {
      const canvas = document.getElementById("kg-canvas");

      function screenToWorld(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        const sx = clientX - rect.left;
        const sy = clientY - rect.top;
        const w = canvas.width;
        const h = canvas.height;
        return {
          x: (sx - w / 2 - CAM.x) / CAM.zoom + w / 2,
          y: (sy - h / 2 - CAM.y) / CAM.zoom + h / 2
        };
      }

      function findNodeAt(wx, wy) {
        for (let i = GRAPH_NODES.length - 1; i >= 0; i--) {
          const n = GRAPH_NODES[i];
          if (!n.visible) continue;
          const dx = wx - n.x;
          const dy = wy - n.y;
          if (dx * dx + dy * dy <= (n.r + 4) * (n.r + 4)) {
            return n;
          }
        }
        return null;
      }

      canvas.addEventListener("mousedown", (e) => {
        const pt = screenToWorld(e.clientX, e.clientY);
        const hit = findNodeAt(pt.x, pt.y);
        if (hit) {
          DRAG_NODE = hit;
          selectGraphNode(hit);
        } else {
          IS_PANNING = true;
          PAN_START = { x: e.clientX - CAM.x, y: e.clientY - CAM.y };
        }
      });

      window.addEventListener("mousemove", (e) => {
        if (DRAG_NODE) {
          const pt = screenToWorld(e.clientX, e.clientY);
          DRAG_NODE.x = pt.x;
          DRAG_NODE.y = pt.y;
          DRAG_NODE.vx = 0;
          DRAG_NODE.vy = 0;
        } else if (IS_PANNING) {
          CAM.x = e.clientX - PAN_START.x;
          CAM.y = e.clientY - PAN_START.y;
        }
      });

      window.addEventListener("mouseup", () => {
        DRAG_NODE = null;
        IS_PANNING = false;
      });

      canvas.addEventListener(
        "wheel",
        (e) => {
          e.preventDefault();
          const factor = e.deltaY < 0 ? 1.12 : 0.89;
          CAM.zoom = Math.max(0.35, Math.min(3.5, CAM.zoom * factor));
        },
        { passive: false }
      );
    })();

    function selectGraphNode(node) {
      SELECTED_NODE = node;
      const connectedEdges = GRAPH_EDGES.filter(
        (e) => e.source_entity === node.entity_id || e.target_entity === node.entity_id
      );

      const inspector = document.getElementById("node-inspector");
      inspector.innerHTML = \`
        <div style="display:flex; align-items:center; justify-content:space-between; flex-wrap:wrap; gap:8px; margin-bottom:8px;">
          <div>
            <span class="badge badge-cyan">\${escapeHtml(node.entity_type)}</span>
            <span class="badge badge-violet">\${escapeHtml(node.namespace)}</span>
            <strong style="font-size:14px; margin-left:6px;">\${escapeHtml(node.canonical_name)}</strong>
            <code style="font-size:11.5px; color:var(--text-2); margin-left:6px;">(\${escapeHtml(node.entity_id)})</code>
          </div>
          <div style="font-family:var(--font-mono); font-size:12px;">
            PageRank Score: <strong style="color:var(--emerald);">\${Number(node.pagerank_score || 0.15).toFixed(3)}</strong> •
            Active Edges: <strong>\${connectedEdges.length}</strong>
          </div>
        </div>
        <div style="display:grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap:8px; max-height:160px; overflow-y:auto;">
          \${
            connectedEdges.length === 0
              ? '<div style="font-size:12px; color:var(--text-2);">No active edges linked to this entity.</div>'
              : connectedEdges
                  .map(
                    (e) => \`
                    <div style="background:var(--bg-0); border:1px solid var(--border); border-radius:6px; padding:6px 10px; font-size:11.5px; font-family:var(--font-mono);">
                      <span style="color:var(--text-1);">\${escapeHtml(e.source_entity)}</span>
                      <span style="color:var(--cyan);"> —[\${escapeHtml(e.relation)}]→ </span>
                      <span style="color:var(--text-1);">\${escapeHtml(e.target_entity)}</span>
                      \${
                        e.evidence_memory_id
                          ? \`<div style="margin-top:4px;"><a href="javascript:void(0)" style="color:var(--emerald); text-decoration:underline;" onclick="inspectMemoryById('\${escapeHtml(e.evidence_memory_id)}')">Inspect Evidence Memory (\${escapeHtml(e.evidence_memory_id.slice(0, 12))}...)</a></div>\`
                          : ""
                      }
                    </div>
                  \`
                  )
                  .join("")
          }
        </div>
      \`;
    }

    // =========================================================================
    // PANEL 3: MEMORY TYPES STATUS & CONTENT EXPLORER BY NAMESPACE
    // =========================================================================
    function renderMemoryTypesAndExplorer(data) {
      const totalsByType = (data.memoryTypesStatus && data.memoryTypesStatus.totalsByType) || [];
      const matrixRows = (data.memoryTypesStatus && data.memoryTypesStatus.byNamespaceAndType) || [];
      const memories = data.memories || [];
      const byNsDecisions = (data.telemetry && data.telemetry.byNamespace && data.telemetry.byNamespace.decisions) || {};

      const typeMeta = {
        semantic: {
          title: "📘 Semantic Memories",
          badge: "badge-cyan",
          desc: "Permanent architectural facts, infrastructure topology, ports & domain knowledge."
        },
        procedural: {
          title: "⚙️ Procedural Memories",
          badge: "badge-emerald",
          desc: "Runbooks, CLI workflows, deployment pipelines & troubleshooting playbooks."
        },
        episodic_summary: {
          title: "🌙 Episodic Summaries",
          badge: "badge-violet",
          desc: "Consolidated daily engineering digests synthesized at 03:00 AM by Llama 3.3 70B."
        }
      };

      const typeMap = new Map();
      totalsByType.forEach((r) => typeMap.set(r.memory_type, r));

      const cardsHtml = ["semantic", "procedural", "episodic_summary"]
        .map((tKey) => {
          const meta = typeMeta[tKey];
          const stat = typeMap.get(tKey) || { count: 0, total_tokens: 0, avg_importance: 0, total_accesses: 0 };
          const isActive = EXPLORER_TYPE === tKey;
          return \`
            <div class="type-stat-card \${isActive ? 'active' : ''}" onclick="setExplorerType('\${tKey}')">
              <div style="display:flex; justify-content:space-between; align-items:center;">
                <span class="badge \${meta.badge}">\${tKey}</span>
                <span style="font-size:11px; color:var(--text-2); font-family:var(--font-mono);">
                  \${(stat.total_tokens || 0).toLocaleString()} tokens
                </span>
              </div>
              <div class="type-stat-num">\${(stat.count || 0).toLocaleString()}</div>
              <div style="font-size:13px; font-weight:700; margin-bottom:4px;">\${meta.title}</div>
              <div style="font-size:11.5px; color:var(--text-2); margin-bottom:8px;">\${meta.desc}</div>
              <div style="font-size:11px; font-family:var(--font-mono); color:var(--text-1); display:flex; justify-content:space-between;">
                <span>Avg Imp: <strong>\${Number(stat.avg_importance || 0).toFixed(2)}</strong></span>
                <span>Recalls: <strong>\${stat.total_accesses || 0}</strong></span>
              </div>
            </div>
          \`;
        })
        .join("");

      const adrCardHtml = \`
        <div class="type-stat-card" onclick="switchTab('tab-sleep', document.querySelector('[data-tab=tab-sleep]'))">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <span class="badge badge-amber">decisions (ADRs)</span>
            <span style="font-size:11px; color:var(--text-2); font-family:var(--font-mono);">Immutable Rules</span>
          </div>
          <div class="type-stat-num">\${(data.telemetry.activeDecisions || 0).toLocaleString()}</div>
          <div style="font-size:13px; font-weight:700; margin-bottom:4px;">📜 Active ADRs</div>
          <div style="font-size:11.5px; color:var(--text-2); margin-bottom:8px;">
            Deterministic Architecture Decision Records injected into every hybrid_recall compilation.
          </div>
          <div style="font-size:11px; font-family:var(--font-mono); color:var(--cyan);">
            Click to inspect ADR rules →
          </div>
        </div>
      \`;

      document.getElementById("memory-type-cards").innerHTML = cardsHtml + adrCardHtml;

      // Build Namespace x Memory Type Matrix Table
      const nsAgg = new Map();
      matrixRows.forEach((r) => {
        const ns = r.namespace || "global";
        if (!nsAgg.has(ns)) {
          nsAgg.set(ns, {
            namespace: ns,
            semantic: 0,
            procedural: 0,
            episodic_summary: 0,
            total_tokens: 0,
            weighted_imp: 0,
            total_count: 0,
            total_accesses: 0
          });
        }
        const entry = nsAgg.get(ns);
        entry[r.memory_type] = (entry[r.memory_type] || 0) + r.count;
        entry.total_tokens += r.total_tokens || 0;
        entry.weighted_imp += (r.avg_importance || 0) * r.count;
        entry.total_count += r.count;
        entry.total_accesses += r.total_accesses || 0;
      });

      // Ensure namespaces that only have ADRs also appear
      Object.keys(byNsDecisions).forEach((ns) => {
        if (!nsAgg.has(ns)) {
          nsAgg.set(ns, {
            namespace: ns,
            semantic: 0,
            procedural: 0,
            episodic_summary: 0,
            total_tokens: 0,
            weighted_imp: 0,
            total_count: 0,
            total_accesses: 0
          });
        }
      });

      const allNamespaces = Array.from(nsAgg.keys()).sort();

      document.getElementById("ns-type-matrix-body").innerHTML = allNamespaces
        .map((ns) => {
          const row = nsAgg.get(ns);
          const avgImp = row.total_count > 0 ? (row.weighted_imp / row.total_count).toFixed(2) : "—";
          const adrCount = byNsDecisions[ns] || 0;
          return \`
            <tr>
              <td>
                <span class="badge badge-cyan" style="cursor:pointer;" onclick="setExplorerNamespace('\${escapeHtml(ns)}')">
                  \${escapeHtml(ns)}
                </span>
              </td>
              <td style="font-family:var(--font-mono);">
                <a href="javascript:void(0)" style="color:var(--text-0); text-decoration:underline;" onclick="setExplorerFilter('\${escapeHtml(ns)}', 'semantic')">
                  \${row.semantic}
                </a>
              </td>
              <td style="font-family:var(--font-mono);">
                <a href="javascript:void(0)" style="color:var(--text-0); text-decoration:underline;" onclick="setExplorerFilter('\${escapeHtml(ns)}', 'procedural')">
                  \${row.procedural}
                </a>
              </td>
              <td style="font-family:var(--font-mono);">
                <a href="javascript:void(0)" style="color:var(--text-0); text-decoration:underline;" onclick="setExplorerFilter('\${escapeHtml(ns)}', 'episodic_summary')">
                  \${row.episodic_summary}
                </a>
              </td>
              <td style="font-family:var(--font-mono);">\${adrCount}</td>
              <td style="font-family:var(--font-mono);">\${row.total_tokens.toLocaleString()} tok</td>
              <td style="font-family:var(--font-mono);">\${avgImp}</td>
              <td style="font-family:var(--font-mono);">\${row.total_accesses}</td>
              <td>
                <button class="btn btn-sm" onclick="setExplorerNamespace('\${escapeHtml(ns)}')">
                  Filter Vault (\${row.total_count})
                </button>
              </td>
            </tr>
          \`;
        })
        .join("");

      // Populate Namespace Filter Pills
      const pillsHtml =
        \`<button class="filter-pill \${EXPLORER_NS === 'all' ? 'active' : ''}" onclick="setExplorerNamespace('all')">All Namespaces (\${memories.length})</button>\` +
        allNamespaces
          .map((ns) => {
            const c = nsAgg.get(ns).total_count;
            const activeCls = EXPLORER_NS === ns ? "active" : "";
            return \`<button class="filter-pill \${activeCls}" onclick="setExplorerNamespace('\${escapeHtml(ns)}')">\${escapeHtml(ns)} (\${c})</button>\`;
          })
          .join("");
      document.getElementById("explorer-ns-pills").innerHTML = pillsHtml;

      renderMemoryExplorer();
    }

    function setExplorerNamespace(ns) {
      EXPLORER_NS = ns;
      if (SNAPSHOT) renderMemoryTypesAndExplorer(SNAPSHOT);
    }

    function setExplorerType(type) {
      EXPLORER_TYPE = type;
      document.querySelectorAll("#explorer-type-pills .filter-pill").forEach((b) => {
        b.classList.toggle("active", b.getAttribute("data-type") === type);
      });
      if (SNAPSHOT) renderMemoryTypesAndExplorer(SNAPSHOT);
    }

    function setExplorerFilter(ns, type) {
      EXPLORER_NS = ns;
      EXPLORER_TYPE = type;
      document.querySelectorAll("#explorer-type-pills .filter-pill").forEach((b) => {
        b.classList.toggle("active", b.getAttribute("data-type") === type);
      });
      if (SNAPSHOT) renderMemoryTypesAndExplorer(SNAPSHOT);
    }

    function renderMemoryExplorer() {
      if (!SNAPSHOT) return;
      const memories = SNAPSHOT.memories || [];
      const q = (document.getElementById("explorer-search").value || "").trim().toLowerCase();

      const filtered = memories.filter((m) => {
        if (EXPLORER_NS !== "all" && m.namespace !== EXPLORER_NS) return false;
        if (EXPLORER_TYPE !== "all" && m.memory_type !== EXPLORER_TYPE) return false;
        if (q) {
          const hay = (m.id + " " + m.title + " " + m.content + " " + (m.source_uri || "")).toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });

      document.getElementById("explorer-count-badge").textContent =
        filtered.length + " Matching Memories";

      const grid = document.getElementById("memories-explorer-grid");
      if (filtered.length === 0) {
        grid.innerHTML =
          '<div style="color:var(--text-2); font-size:13px; padding:16px;">No memories match the active namespace/type/keyword filter.</div>';
        return;
      }

      grid.innerHTML = filtered
        .map((m) => {
          const typeBadge =
            m.memory_type === "procedural"
              ? "badge-emerald"
              : m.memory_type === "episodic_summary"
              ? "badge-violet"
              : "badge-cyan";
          return \`
            <div class="memory-card">
              <div>
                <div style="display:flex; justify-content:space-between; align-items:center; gap:6px; flex-wrap:wrap;">
                  <div style="display:flex; gap:6px; align-items:center;">
                    <span class="badge badge-slate">\${escapeHtml(m.namespace)}</span>
                    <span class="badge \${typeBadge}">\${escapeHtml(m.memory_type)}</span>
                  </div>
                  <span style="font-size:11px; color:var(--text-2); font-family:var(--font-mono);">
                    \${formatRelativeTime(m.updated_at)}
                  </span>
                </div>
                <div class="memory-title">\${escapeHtml(m.title)}</div>
                <div style="font-size:11px; color:var(--text-3); font-family:var(--font-mono); margin:4px 0 8px;">
                  ID: \${escapeHtml(m.id)} \${m.source_uri ? "• URI: " + escapeHtml(m.source_uri) : ""}
                </div>
                <div class="memory-preview">\${escapeHtml(m.content)}</div>
              </div>
              <div style="display:flex; justify-content:space-between; align-items:center; padding-top:6px; border-top:1px solid var(--border); font-size:11.5px; font-family:var(--font-mono); color:var(--text-2);">
                <span>\${m.token_count} tok • Imp: \${Number(m.importance).toFixed(2)} • Recalls: \${m.access_count}</span>
                <button class="btn btn-sm" onclick="inspectMemoryById('\${escapeHtml(m.id)}')">
                  🔎 Inspect Full
                </button>
              </div>
            </div>
          \`;
        })
        .join("");
    }

    function inspectMemoryById(memId) {
      if (!SNAPSHOT) return;
      const m = (SNAPSHOT.memories || []).find((x) => x.id === memId);
      if (!m) return;

      const linkedEdges = ((SNAPSHOT.graph && SNAPSHOT.graph.edges) || []).filter(
        (e) => e.evidence_memory_id === m.id
      );

      document.getElementById("modal-title").textContent = "[" + m.namespace + "] " + m.title;
      document.getElementById("modal-content").innerHTML = \`
        <div style="display:flex; flex-wrap:wrap; gap:8px; margin-bottom:14px;">
          <span class="badge badge-cyan">Namespace: \${escapeHtml(m.namespace)}</span>
          <span class="badge badge-emerald">Type: \${escapeHtml(m.memory_type)}</span>
          <span class="badge badge-violet">Tokens: \${m.token_count}</span>
          <span class="badge badge-amber">Importance: \${Number(m.importance).toFixed(2)}</span>
          <span class="badge badge-slate">Confidence: \${Number(m.confidence).toFixed(2)}</span>
          <span class="badge badge-slate">Recalls: \${m.access_count}</span>
        </div>
        <div style="font-size:12px; color:var(--text-2); font-family:var(--font-mono); margin-bottom:12px;">
          <div><strong>Memory ID:</strong> \${escapeHtml(m.id)}</div>
          <div><strong>Source URI:</strong> \${escapeHtml(m.source_uri || "N/A")}</div>
          <div><strong>Updated:</strong> \${formatIsoShort(m.updated_at)} (\${formatRelativeTime(m.updated_at)})</div>
        </div>
        <div style="font-size:12px; font-weight:700; text-transform:uppercase; color:var(--text-2); margin-bottom:6px;">
          Full Memory Content
        </div>
        <pre class="code-block">\${escapeHtml(m.content)}</pre>
        \${
          linkedEdges.length > 0
            ? \`
              <div style="font-size:12px; font-weight:700; text-transform:uppercase; color:var(--text-2); margin:14px 0 6px;">
                Linked Knowledge Graph Triples (\${linkedEdges.length})
              </div>
              <div style="display:grid; gap:6px;">
                \${linkedEdges
                  .map(
                    (e) => \`
                    <div style="background:var(--bg-0); border:1px solid var(--border); padding:7px 10px; border-radius:6px; font-family:var(--font-mono); font-size:12px;">
                      \${escapeHtml(e.source_entity)} <span style="color:var(--cyan);">—[\${escapeHtml(e.relation)}]→</span> \${escapeHtml(e.target_entity)}
                    </div>
                  \`
                  )
                  .join("")}
              </div>
            \`
            : ""
        }
      \`;
      document.getElementById("memory-modal").classList.add("open");
    }

    function closeMemoryModal() {
      document.getElementById("memory-modal").classList.remove("open");
    }

    // =========================================================================
    // PANEL 4: 4-WAY RRF SEARCH PLAYGROUND
    // =========================================================================
    async function runRecallPlayground(e) {
      if (e) e.preventDefault();
      const query = document.getElementById("recall-query").value.trim();
      const namespace = document.getElementById("recall-namespace").value;
      const tokenBudget = Number(document.getElementById("recall-budget").value) || 2000;
      const btn = document.getElementById("recall-submit-btn");
      const container = document.getElementById("recall-results-container");

      btn.disabled = true;
      btn.textContent = "⏳ Running 4-Way Federated RRF + Cross-Encoder...";

      try {
        const res = await apiNocCall("recall", { query, namespace, tokenBudget });

        const candidates = res.candidates || [];
        container.innerHTML = \`
          <div style="display:flex; flex-wrap:wrap; gap:6px; margin-bottom:12px;">
            <span class="badge badge-emerald">Packed: \${res.tokensUsed} / \${res.tokenBudget} tok</span>
            <span class="badge badge-cyan">Brain Hits: \${res.brainCount}</span>
            <span class="badge badge-violet">D1 KB Hits: \${res.kbCount}</span>
            <span class="badge badge-amber">1-Hop Triples: \${res.graphTriplesCount}</span>
          </div>

          <div style="font-size:11.5px; font-weight:700; color:var(--text-1); margin-bottom:8px; text-transform:uppercase;">
            Fused Candidate Ranking Breakdown (\${candidates.length} Candidates)
          </div>
          <div style="max-height:280px; overflow-y:auto; margin-bottom:12px;">
            \${candidates
              .slice(0, 10)
              .map(
                (c, idx) => \`
                <div style="background:var(--bg-0); border:1px solid var(--border); border-radius:8px; padding:9px 11px; margin-bottom:7px;">
                  <div style="display:flex; justify-content:space-between; gap:6px; align-items:center;">
                    <strong style="font-size:12px; color:var(--text-0);">#\${idx + 1} \${escapeHtml(c.title)} \${c.memoryType === 'episodic_summary' ? '<span class="badge badge-amber" style="font-size:9.5px; margin-left:4px;">DIGEST</span>' : ''}</strong>
                    <span class="badge \${c.origin === 'brain.tsimon.me' ? 'badge-cyan' : 'badge-violet'}">\${escapeHtml(c.origin)}</span>
                  </div>
                  <div style="font-size:11px; font-family:var(--font-mono); color:var(--text-2); margin-top:5px; display:flex; flex-wrap:wrap; gap:8px;">
                    <span>Score: <strong style="color:var(--emerald);">\${Number(c.rrfScore || 0).toFixed(4)}</strong></span>
                    \${c.rerankScore !== undefined ? \`<span>Reranker: <strong style="color:var(--cyan);">\${Number(c.rerankScore).toFixed(3)}</strong></span>\` : ""}
                    <span>Signals: <strong>\${escapeHtml((c.sources || [c.source]).join("+"))}</strong></span>
                    \${c.explanation?.modifiers ? \`<span>Imp:<strong>\${c.explanation.modifiers.importance}</strong> Conf:<strong>\${c.explanation.modifiers.confidence}</strong> Decay:<strong>\${c.explanation.modifiers.decayFactor}</strong> (\${c.explanation.modifiers.ageDays}d)</span>\` : ""}
                  </div>
                </div>
              \`
              )
              .join("")}
          </div>

          <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
            <span style="font-size:11.5px; font-weight:700; color:var(--text-1); text-transform:uppercase;">Compiled &lt;brain_context&gt; Output</span>
            <button class="btn btn-sm" onclick="navigator.clipboard.writeText(window.__LAST_COMPILED_CONTEXT || ''); this.textContent='✓ Copied!'">
              📋 Copy Context
            </button>
          </div>
          <pre class="code-block" style="max-height:240px;">\${escapeHtml(res.compiledMarkdown || "")}</pre>
        \`;
        window.__LAST_COMPILED_CONTEXT = res.compiledMarkdown || "";
      } catch (err) {
        container.innerHTML = \`<div class="auth-error" style="display:block;">\${escapeHtml(err.message)}</div>\`;
      } finally {
        btn.disabled = false;
        btn.textContent = "⚡ Execute 4-Way Federated Recall";
      }
    }

    // =========================================================================
    // PANEL 5: SLEEP CYCLE, EPISODIC LOGS, ADRS & MUTATION ROLLBACK
    // =========================================================================
    function renderSleepCycleAndAudit(data) {
      const sc = data.sleepCycle || {};
      const pendingLogs = sc.pendingLogs || [];
      const runs = sc.consolidationRuns || [];
      const mutations = sc.recentMutations || [];
      const adrs = sc.activeDecisions || [];
      const conflicts = sc.conflicts || [];
      const pendingConflicts = conflicts.filter((c) => c.status === "pending");

      const confBadge = document.getElementById("conflicts-count-badge");
      if (confBadge) {
        confBadge.textContent =
          pendingConflicts.length + " Pending • " + (conflicts.length - pendingConflicts.length) + " Resolved";
        confBadge.className = "badge " + (pendingConflicts.length > 0 ? "badge-amber" : "badge-emerald");
      }

      document.getElementById("pending-episodic-badge").textContent =
        (sc.pendingCount || 0) + " Pending Consolidation";
      document.getElementById("consolidation-runs-badge").textContent =
        runs.length + " Sleep Cycles";
      document.getElementById("mutations-count-badge").textContent =
        mutations.length + " Recent Mutations";
      document.getElementById("adrs-count-badge").textContent =
        adrs.length + " Active Rules";

      // 0. Semantic Contradiction Triage Queue (memory_conflicts)
      const confContainer = document.getElementById("conflicts-container");
      if (confContainer) {
        confContainer.innerHTML =
          conflicts.length === 0
            ? '<div style="font-size:12.5px; color:var(--emerald);">✓ No semantic or Knowledge Graph contradictions detected. Click "🔍 Run Contradiction Audit Now" to compare recent memories against existing semantic triples and ADRs.</div>'
            : conflicts
                .map((c) => {
                  const isPending = c.status === "pending";
                  const sevBadge =
                    c.severity === "high"
                      ? "badge-rose"
                      : c.severity === "low"
                      ? "badge-slate"
                      : "badge-amber";
                  const oldRef = c.existing_memory_id || c.existing_edge_id || c.existing_decision_id || "unknown";
                  const newRef = c.new_memory_id || c.new_edge_id || "latest";
                  return \`
                    <div class="surface-card" style="border-color: \${isPending ? 'rgba(245, 158, 11, 0.45)' : 'var(--border)'};">
                      <div class="surface-top">
                        <div style="display:flex; flex-wrap:wrap; gap:6px; align-items:center;">
                          <span class="badge \${isPending ? 'badge-amber' : 'badge-emerald'}">
                            \${isPending ? '⚠️ PENDING TRIAGE' : '✓ RESOLVED (' + escapeHtml((c.resolution_action || '').toUpperCase()) + ')'}
                          </span>
                          <span class="badge \${sevBadge}">\${escapeHtml(c.severity.toUpperCase())}</span>
                          <span class="badge badge-cyan">\${escapeHtml(c.conflict_type)}</span>
                          <span class="badge badge-slate">\${escapeHtml(c.namespace)}</span>
                          <strong style="font-size:12.5px;">Conflict #\${c.conflict_id}</strong>
                          <span style="font-size:11px; color:var(--text-2); font-family:var(--font-mono);">
                            Recommended: <strong style="color:var(--cyan);">\${escapeHtml(c.suggested_action)}</strong> • \${formatRelativeTime(c.created_at)}
                          </span>
                        </div>
                        \${
                          isPending
                            ? \`
                              <div style="display:flex; gap:6px; flex-wrap:wrap;">
                                <button class="btn btn-sm" onclick="resolveConflictById(\${c.conflict_id}, 'keep')" title="Keep existing memory/triple as authoritative">
                                  ✓ Keep Existing
                                </button>
                                <button class="btn btn-sm btn-amber" onclick="resolveConflictById(\${c.conflict_id}, 'supersede')" title="Supersede old memory/triple & clean Vectorize">
                                  ⚡ Supersede Old
                                </button>
                                <button class="btn btn-sm btn-emerald" onclick="resolveConflictById(\${c.conflict_id}, 'merge')" title="Synthesize old + new into updated memory">
                                  🔀 Merge Both
                                </button>
                              </div>
                            \`
                            : \`<span style="font-size:11px; color:var(--text-2); font-family:var(--font-mono);">by \${escapeHtml(c.resolved_by || 'operator')}</span>\`
                        }
                      </div>
                      <div style="font-size:12px; color:var(--text-0); margin:6px 0;">
                        <strong>Why Flagged:</strong> \${escapeHtml(c.reason)}
                      </div>
                      <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap:8px;">
                        <div class="diff-box diff-old" style="margin-top:0;">- EXISTING (\${escapeHtml(oldRef)}): \${escapeHtml(c.existing_title || "")}<br/>\${escapeHtml(c.existing_snippet || "")}</div>
                        <div class="diff-box diff-new" style="margin-top:0;">+ NEW (\${escapeHtml(newRef)}): \${escapeHtml(c.new_title || "")}<br/>\${escapeHtml(c.new_snippet || "")}</div>
                      </div>
                    </div>
                  \`;
                })
                .join("");
      }

      // 1. Episodic Logs
      document.getElementById("episodic-logs-container").innerHTML =
        pendingLogs.length === 0
          ? '<div style="font-size:12px; color:var(--text-2);">No episodic logs recorded yet.</div>'
          : pendingLogs
              .map(
                (l) => \`
                <div class="surface-card">
                  <div class="surface-top">
                    <div>
                      <span class="badge \${l.consolidated ? 'badge-slate' : 'badge-amber'}">
                        \${l.consolidated ? 'CONSOLIDATED' : 'PENDING 03:00 AM'}
                      </span>
                      <span class="badge badge-cyan">\${escapeHtml(l.event_type)}</span>
                      <code style="font-size:11.5px; color:var(--text-1); margin-left:6px;">\${escapeHtml(l.client_id)}</code>
                    </div>
                    <span style="font-size:11px; color:var(--text-2); font-family:var(--font-mono);">
                      #\${l.log_id} • \${formatRelativeTime(l.created_at)}
                    </span>
                  </div>
                  <div class="memory-preview" style="margin-top:6px;">\${escapeHtml(l.payload)}</div>
                </div>
              \`
              )
              .join("");

      // 2. Consolidation Runs
      document.getElementById("consolidation-runs-container").innerHTML =
        runs.length === 0
          ? '<div style="font-size:12px; color:var(--text-2);">No nocturnal consolidation runs recorded yet.</div>'
          : runs
              .map(
                (r) => \`
                <div class="surface-card">
                  <div class="surface-top">
                    <span class="surface-name">\${escapeHtml(r.digest_title || "Nocturnal Digest Run #" + r.run_id)}</span>
                    <span class="badge badge-violet">\${escapeHtml(r.trigger_source)} • \${r.events_count} events</span>
                  </div>
                  <div style="font-size:11px; color:var(--text-2); font-family:var(--font-mono); margin-bottom:6px;">
                    \${formatIsoShort(r.created_at)} • Clients: \${escapeHtml(r.clients_json)}
                  </div>
                  <div class="memory-preview">\${escapeHtml(r.digest_content || "")}</div>
                </div>
              \`
              )
              .join("");

      // 3. Mutations & Diff Rollback
      document.getElementById("mutations-container").innerHTML =
        mutations.length === 0
          ? '<div style="font-size:12px; color:var(--text-2);">No mutations recorded yet.</div>'
          : mutations
              .map((m) => {
                const opBadge =
                  m.operation === "INSERT"
                    ? "badge-emerald"
                    : m.operation === "UPDATE"
                    ? "badge-cyan"
                    : m.operation === "ROLLBACK"
                    ? "badge-rose"
                    : "badge-violet";
                return \`
                  <div class="surface-card">
                    <div class="surface-top">
                      <div>
                        <span class="badge \${opBadge}">\${escapeHtml(m.operation)}</span>
                        <span class="badge badge-slate">\${escapeHtml(m.namespace)}</span>
                        <strong style="font-size:12.5px; margin-left:6px;">\${escapeHtml(m.new_title || m.old_title || m.memory_id)}</strong>
                      </div>
                      <div style="display:flex; gap:6px; align-items:center;">
                        <span style="font-size:11px; color:var(--text-2); font-family:var(--font-mono);">
                          #\${m.mutation_id} by \${escapeHtml(m.client_id)} • \${formatRelativeTime(m.created_at)}
                        </span>
                        \${
                          m.rolled_back === 0 && m.operation !== "ROLLBACK"
                            ? \`<button class="btn btn-sm btn-rose" onclick="rollbackMutationById(\${m.mutation_id})">⏪ Rollback</button>\`
                            : \`<span class="badge badge-rose">ROLLED BACK</span>\`
                        }
                      </div>
                    </div>
                    \${
                      m.old_content
                        ? \`<div class="diff-box diff-old">- BEFORE: \${escapeHtml(m.old_content.slice(0, 360))}</div>\`
                        : ""
                    }
                    \${
                      m.new_content
                        ? \`<div class="diff-box diff-new">+ AFTER: \${escapeHtml(m.new_content.slice(0, 360))}</div>\`
                        : ""
                    }
                  </div>
                \`;
              })
              .join("");

      // 4. Active ADRs
      document.getElementById("adrs-container").innerHTML =
        adrs.length === 0
          ? '<div style="font-size:12px; color:var(--text-2);">No active ADRs found.</div>'
          : adrs
              .map(
                (a) => \`
                <div class="surface-card">
                  <div class="surface-top">
                    <span class="surface-name">[\${escapeHtml(a.decision_id)}] \${escapeHtml(a.title)}</span>
                    <span class="badge badge-emerald">\${escapeHtml(a.namespace)}</span>
                  </div>
                  <div style="font-size:12px; color:var(--text-0); margin-top:6px;">
                    <strong>Decision:</strong> \${escapeHtml(a.decision)}
                  </div>
                  <div style="font-size:11.5px; color:var(--text-2); margin-top:4px;">
                    <strong>Rationale:</strong> \${escapeHtml(a.rationale)}
                  </div>
                </div>
              \`
              )
              .join("");
    }

    async function triggerConsolidationNow() {
      const btn = document.getElementById("btn-consolidate");
      btn.disabled = true;
      btn.textContent = "🌙 Consolidating...";
      try {
        const res = await apiNocCall("consolidate", { triggerSource: "dashboard_noc" });
        alert(
          "Sleep Cycle Complete! Consolidated " +
            (res.consolidatedCount || 0) +
            " episodic events | Detected " +
            (res.conflictsDetected || 0) +
            " new conflict(s) (" +
            (res.pendingConflictsCount || 0) +
            " pending). Next alarm: " +
            (res.nextAlarmIso || "scheduled")
        );
        await refreshDashboard();
      } catch (err) {
        alert("Consolidation error: " + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = "🌙 Run Sleep Cycle Now";
      }
    }

    async function triggerConflictAuditNow() {
      const btn = document.getElementById("btn-audit-conflicts");
      if (btn) {
        btn.disabled = true;
        btn.textContent = "⏳ Auditing Contradictions...";
      }
      try {
        const res = await apiNocCall("audit_conflicts", { hours: 24, limit: 5 });
        alert(
          "Semantic Contradiction Audit Complete! Audited " +
            (res.auditedMemoriesCount || 0) +
            " recent memories -> Detected " +
            (res.detectedCount || 0) +
            " new conflict(s) (" +
            (res.pendingCount || 0) +
            " total pending)."
        );
        await refreshDashboard();
      } catch (err) {
        alert("Contradiction audit error: " + err.message);
      } finally {
        if (btn) {
          btn.disabled = false;
          btn.textContent = "🔍 Run Contradiction Audit Now";
        }
      }
    }

    async function resolveConflictById(conflictId, action) {
      const labels = {
        keep: "KEEP the existing memory/triple and dismiss Conflict #" + conflictId,
        supersede: "SUPERSEDE the older memory/triple (and remove stale vector) for Conflict #" + conflictId,
        merge: "MERGE old + new observations into an updated authoritative memory for Conflict #" + conflictId
      };
      if (!confirm("Confirm 15s Governance Triage:\\n\\n" + (labels[action] || action) + "?")) {
        return;
      }
      try {
        const res = await apiNocCall("resolve_conflict", {
          conflictId,
          action,
          clientId: "dashboard-noc-operator"
        });
        alert("Conflict #" + conflictId + " resolved via '" + res.action + "'!");
        await refreshDashboard();
      } catch (err) {
        alert("Conflict resolution failed: " + err.message);
      }
    }

    async function triggerReindexNow() {
      const btn = document.getElementById("btn-reindex");
      btn.disabled = true;
      btn.textContent = "⚡ Reindexing...";
      try {
        const res = await apiNocCall("reindex", { rebuildFts: true, hours: 720, limit: 50 });
        alert(
          "FTS5 & Vectorize Reindex Complete! Re-embedded " +
            (res.reindexedVectors || 0) +
            " active memories."
        );
        await refreshDashboard();
      } catch (err) {
        alert("Reindex error: " + err.message);
      } finally {
        btn.disabled = false;
        btn.textContent = "⚡ Reindex FTS5/Vectors";
      }
    }

    async function rollbackMutationById(mutationId) {
      if (!confirm("Roll back mutation #" + mutationId + " and restore previous vector/SQLite state?")) {
        return;
      }
      try {
        const res = await apiNocCall("rollback", {
          mutationId,
          clientId: "dashboard-noc-operator"
        });
        alert("Rollback succeeded: " + res.action + " (" + res.memoryId + ")");
        await refreshDashboard();
      } catch (err) {
        alert("Rollback failed: " + err.message);
      }
    }

    // Auto-boot if token already exists in browser storage
    window.addEventListener("DOMContentLoaded", async () => {
      const params = new URLSearchParams(window.location.search);
      if (params.has("reset") || params.has("logout")) {
        lockSession();
        try {
          const cleanUrl = new URL(window.location.href);
          cleanUrl.searchParams.delete("reset");
          cleanUrl.searchParams.delete("logout");
          if (cleanUrl.pathname === "/mcp" && !cleanUrl.searchParams.has("ui")) {
            cleanUrl.searchParams.set("ui", "1");
          }
          window.history.replaceState({}, "", cleanUrl.pathname + cleanUrl.search);
        } catch {}
        return;
      }
      const existing = getStoredToken();
      if (existing) {
        try {
          await refreshDashboard();
          document.getElementById("auth-overlay").classList.add("hidden");
        } catch (err) {
          lockSession();
          const errBox = document.getElementById("auth-error");
          errBox.textContent = err.message || "Saved session expired or invalid.";
          errBox.style.display = "block";
        }
      }
    });
  </script>
</body>
</html>`;
}
