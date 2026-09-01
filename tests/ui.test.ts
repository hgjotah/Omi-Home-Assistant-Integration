import { describe, expect, it } from "vitest";
import { renderApp } from "../src/ui";

describe("interfaz web", () => {
  it("entrega JavaScript embebido sintácticamente válido", async () => {
    const markup = await renderApp("csrf-test").text();
    const start = markup.indexOf("<script>") + "<script>".length;
    const end = markup.lastIndexOf("</script>");

    expect(start).toBeGreaterThan("<script>".length - 1);
    expect(end).toBeGreaterThan(start);
    expect(() => new Function(markup.slice(start, end))).not.toThrow();
  });

  it("neutraliza un cierre de script dentro del token CSRF", async () => {
    const markup = await renderApp("</script><script>alert(1)</script>").text();

    expect(markup).not.toContain("const CSRF=\"</script>");
    expect(markup).toContain("\\u003c/script>");
  });
});
