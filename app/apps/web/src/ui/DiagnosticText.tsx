/**
 * Diagnostics quote identifiers in backticks ("The shoulder of `nose`..."). The
 * one place that formatting is read, so the check panel, the inspector and the
 * field messages say the same thing. An unmatched backtick is left as written.
 */
import "./ui.css";

const QUOTE = "`";

/** Matched quotes split the text into an odd number of parts; identifiers are the odd-indexed ones. */
function quotedParts(text: string): string[] | null {
  const parts = text.split(QUOTE);
  return parts.length % 2 === 0 ? null : parts;
}

/** The same text for a place that cannot hold markup: a `title` attribute. */
export function diagnosticPlainText(text: string): string {
  return quotedParts(text)?.join("") ?? text;
}

/** Diagnostic text with its quoted identifiers set as code. */
export function DiagnosticText({ text }: { text: string }) {
  const parts = quotedParts(text);
  if (parts === null) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <code key={i} className="rw-diag-code">
            {part}
          </code>
        ) : (
          part
        ),
      )}
    </>
  );
}
