import { describe, expect, it } from "vitest";
import { renderDashboardHtml } from "../src/dashboard";

function extractDashboardScript(html: string): string {
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!match) throw new Error("Inline <script> tag not found in dashboard HTML");
  return match[1];
}

function runRenderSurfacesAndDatabases(html: string, snapshot: unknown) {
  const script = extractDashboardScript(html);
  const elements = new Map<
    string,
    {
      innerHTML: string;
      textContent: string;
      attrs: Record<string, string>;
      classes: Set<string>;
      setAttribute: (k: string, v: string) => void;
      getAttribute: (k: string) => string | null;
      classList: { toggle: (cls: string, force?: boolean) => void };
    }
  >();

  const ensureEl = (id: string) => {
    if (!elements.has(id)) {
      const attrs: Record<string, string> = {};
      const classes = new Set<string>();
      elements.set(id, {
        innerHTML: "",
        textContent: "",
        attrs,
        classes,
        setAttribute: (k: string, v: string) => {
          attrs[k] = String(v);
        },
        getAttribute: (k: string) => attrs[k] ?? null,
        addEventListener: () => {},
        classList: {
          toggle: (cls: string, force?: boolean) => {
            if (force === true) classes.add(cls);
            else if (force === false) classes.delete(cls);
            else if (classes.has(cls)) classes.delete(cls);
            else classes.add(cls);
          }
        }
      });
    }
    return elements.get(id)!;
  };

  const mockDocument = {
    getElementById: (id: string) => ensureEl(id),
    querySelectorAll: () => []
  };
  const mockWindow = {
    addEventListener: () => {},
    location: { href: "https://brain.tsimon.me/mcp?ui=1", search: "?ui=1" },
    history: { replaceState: () => {} }
  };
  const mockStorage = {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {}
  };

  // Patch out setInterval and setupCanvasEvents IIFE side effects when invoking in Node
  const executable = `
    const window = arguments[0];
    const document = arguments[1];
    const localStorage = arguments[2];
    const sessionStorage = arguments[2];
    const setInterval = () => 0;
    const requestAnimationFrame = () => 0;
    ${script}
    renderSurfacesAndDatabases(arguments[3]);
    return {
      surfacesHtml: document.getElementById("surfaces-container").innerHTML,
      databasesHtml: document.getElementById("databases-container").innerHTML,
      badgeText: document.getElementById("surfaces-count-badge").textContent
    };
  `;

  const fn = new Function(executable);
  return fn(mockWindow, mockDocument, mockStorage, snapshot) as {
    surfacesHtml: string;
    databasesHtml: string;
    badgeText: string;
  };
}

describe("Cognitive NOC Dashboard layout (src/dashboard.ts)", () => {
  const html = renderDashboardHtml("tsimon.me", "1.7.3");

  it("keeps kpi-strip locked on the same non-wrapping row as brand-title and brand-sub", () => {
    expect(html).toContain('<div class="header-primary">');
    expect(html).toMatch(/\.header-primary\s*\{[^}]*flex-wrap:\s*nowrap;/s);
    expect(html).toMatch(/\.kpi-strip\s*\{[^}]*container-type:\s*inline-size;[^}]*min-width:\s*0;/s);
    expect(html).toMatch(/\.kpi-strip-track\s*\{[^}]*flex-wrap:\s*nowrap;/s);
    expect(html).toContain("function setKpiValue(");
    expect(html).toContain("@container kpi-strip");
  });

  it("folds surfaces-container by default after the last 2 most recently active surfaces", () => {
    expect(html).toContain("const VISIBLE_SURFACES_DEFAULT = 2;");
    expect(html).toContain("let SURFACES_EXPANDED = false;");
    expect(html).toContain("function toggleSurfacesFold()");
    expect(html).toContain("function syncSurfacesFoldUi()");

    const now = Math.floor(Date.now() / 1000);
    const { surfacesHtml, badgeText } = runRenderSurfacesAndDatabases(html, {
      surfaces: {
        mutationClients: [
          { client_id: "antigravity-win11", mutations_count: 50, last_mutation_at: now - 3600 },
          { client_id: "gemini-web-architect", mutations_count: 3, last_mutation_at: now - 30 },
          { client_id: "gemini-cli-win11", mutations_count: 8, last_mutation_at: now - 120 },
          { client_id: "rpi5-debian13-daemon", mutations_count: 15, last_mutation_at: now - 7200 },
          { client_id: "antigravity-cli-rpi5", mutations_count: 4, last_mutation_at: now - 900 }
        ],
        episodicClients: [],
        rpi5Preserved: { rpiSyncEnabled: true, preservedEntities: 10, preservedActiveEdges: 20 }
      },
      sleepCycle: {
        consolidationRuns: [{ created_at: now - 1800 }]
      },
      databases: []
    });

    const [primarySection, extraSection] = surfacesHtml.split('id="surfaces-extra"');

    // Primary folded view must contain the 2 most recently active surfaces in order: Web Bridge (30s) then Win11 CLI (120s)
    expect(primarySection).toContain("gemini-web-architect");
    expect(primarySection).toContain("gemini-cli-win11");
    expect(primarySection.indexOf("gemini-web-architect")).toBeLessThan(
      primarySection.indexOf("gemini-cli-win11")
    );
    expect(primarySection).not.toContain("antigravity-win11");
    expect(primarySection).not.toContain("rpi5-debian13-daemon");

    // Folded extra section must contain the remaining 4 surfaces ordered most-recent to oldest:
    // antigravity-cli-rpi5 (900s) -> nocturnal-consolidator (1800s) -> antigravity-win11 (3600s) -> rpi5-debian13-daemon (7200s)
    const idxRpiCli = extraSection.indexOf("antigravity-cli-rpi5");
    const idxNocturnal = extraSection.indexOf("nocturnal-consolidator");
    const idxAg = extraSection.indexOf("antigravity-win11");
    const idxRpi = extraSection.indexOf("rpi5-debian13-daemon");
    expect(idxRpiCli).toBeGreaterThan(-1);
    expect(idxRpiCli).toBeLessThan(idxNocturnal);
    expect(idxNocturnal).toBeLessThan(idxAg);
    expect(idxAg).toBeLessThan(idxRpi);

    expect(badgeText).toBe("2/6 Active ▾");
  });

  it("sorts Federated Databases & Indexes from most recently active to oldest", () => {
    const now = Math.floor(Date.now() / 1000);
    const { databasesHtml } = runRenderSurfacesAndDatabases(html, {
      surfaces: { mutationClients: [], episodicClients: [], rpi5Preserved: {} },
      sleepCycle: { consolidationRuns: [] },
      databases: [
        {
          id: "kb-d1-archive",
          name: "archive-knowledge-db",
          engine: "D1",
          status: "ONLINE_FEDERATED",
          details: "D1 archive",
          lastActivityAt: now - 86400
        },
        {
          id: "rpi5-qdrant-edge",
          name: "service:rpi5-qdrant-knowledge-hub",
          engine: "Qdrant",
          status: "ONLINE_FEDERATED",
          details: "RPi5 Qdrant",
          lastActivityAt: now - 60
        },
        {
          id: "brain-do-sqlite",
          name: "BrainMemoryDO SQLite",
          engine: "DO SQLite",
          status: "ONLINE",
          details: "Primary DO",
          lastActivityAt: now - 10
        },
        {
          id: "kb-vectorize-768",
          name: "archive-kb-index",
          engine: "Vectorize 768",
          status: "ONLINE",
          details: "KB vectors",
          lastActivityAt: now - 3600
        }
      ]
    });

    const idxDo = databasesHtml.indexOf("BrainMemoryDO SQLite");
    const idxRpi = databasesHtml.indexOf("service:rpi5-qdrant-knowledge-hub");
    const idxKbVec = databasesHtml.indexOf("archive-kb-index");
    const idxD1 = databasesHtml.indexOf("archive-knowledge-db");

    expect(idxDo).toBeGreaterThan(-1);
    expect(idxDo).toBeLessThan(idxRpi);
    expect(idxRpi).toBeLessThan(idxKbVec);
    expect(idxKbVec).toBeLessThan(idxD1);
    expect(databasesHtml).toContain("Last Activity:");
  });

  it("contains syntactically valid inline dashboard script", () => {
    const script = extractDashboardScript(html);
    expect(() => new Function(script)).not.toThrow();
  });
});
