import { describe, it, expect } from "vitest";
import { parseSseFrame, safeExternalUrl } from "./client";
describe("tutor stream protocol", () => {
  it("parses event and JSON without rendering provider markup", () =>
    expect(
      parseSseFrame('event: token\ndata: {"text":"<script>x</script>"}'),
    ).toEqual({ event: "token", data: { text: "<script>x</script>" } }));
  it("accepts CRLF frames", () =>
    expect(
      parseSseFrame('event: token\r\ndata: {"text":"Hello"}').data.text,
    ).toBe("Hello"));
  it("handles completion", () =>
    expect(parseSseFrame("event: done\ndata: [DONE]")).toEqual({
      event: "done",
      data: null,
    }));
});
describe("outbound content links", () => {
  it("blocks executable and relative URLs", () => {
    expect(safeExternalUrl("javascript:alert(1)")).toBe(null);
    expect(safeExternalUrl("/api/auth/logout")).toBe(null);
  });
  it("allows source links", () =>
    expect(safeExternalUrl("https://example.org/story")).toBe(
      "https://example.org/story",
    ));
});
