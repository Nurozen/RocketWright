import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DiagnosticText, diagnosticPlainText } from "./DiagnosticText.tsx";

describe("diagnostic text", () => {
  it("sets quoted identifiers as code, without the backticks", () => {
    expect(renderToStaticMarkup(<DiagnosticText text="The shoulder of `nose` meets `recovery_bay`" />)).toBe('The shoulder of <code class="rw-diag-code">nose</code> meets <code class="rw-diag-code">recovery_bay</code>');
  });

  it("leaves an unmatched backtick as written", () => {
    expect(renderToStaticMarkup(<DiagnosticText text="a ` b" />)).toBe("a ` b");
    expect(diagnosticPlainText("a ` b")).toBe("a ` b");
  });

  it("drops the quotes where markup cannot go", () => {
    expect(diagnosticPlainText("engine `demo` has no fluid")).toBe("engine demo has no fluid");
  });
});
