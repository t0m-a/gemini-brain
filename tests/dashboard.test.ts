import { describe, expect, it } from "vitest";
import { renderDashboardHtml } from "../src/dashboard";

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

  it("folds surfaces-container by default after the first 2 connected client surfaces", () => {
    expect(html).toContain("const VISIBLE_SURFACES_DEFAULT = 2;");
    expect(html).toContain("let SURFACES_EXPANDED = false;");
    expect(html).toContain("function toggleSurfacesFold()");
    expect(html).toContain("function syncSurfacesFoldUi()");
    expect(html).toContain('id="surfaces-count-badge"');
    expect(html).toContain('onclick="toggleSurfacesFold()"');
    expect(html).toContain('class="surfaces-extra');
  });

  it("contains syntactically valid inline dashboard script", () => {
    const match = html.match(/<script>([\s\S]*?)<\/script>/);
    expect(match).not.toBeNull();
    // Parsing with Function constructor catches any JS syntax errors in template literals
    expect(() => new Function(match![1])).not.toThrow();
  });
});
