import { describe, expect, it } from "vitest";
import { nextTheme, statusToneFor } from "../theme";

describe("theme and status semantics", () => {
  it("cycles system, light and dark without exposing raw palette values", () => {
    expect(nextTheme("system")).toBe("light");
    expect(nextTheme("light")).toBe("dark");
    expect(nextTheme("dark")).toBe("system");
  });

  it("maps service vocabulary to labelled status meanings", () => {
    expect(statusToneFor("returned")).toBe("success");
    expect(statusToneFor("missing")).toBe("danger");
    expect(statusToneFor("needs review")).toBe("warning");
    expect(statusToneFor("assigned")).toBe("info");
    expect(statusToneFor("unknown state")).toBe("neutral");
  });

  it("does not mistake withheld or unreleased grades for success", () => {
    expect(statusToneFor("not returned")).toBe("warning");
    expect(statusToneFor("graded_not_returned")).toBe("warning");
    expect(statusToneFor("awaiting feedback")).toBe("warning");
  });
});
