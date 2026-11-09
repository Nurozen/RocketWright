/**
 * Keeps one part of the window's failure to itself (R3.3): the page that threw
 * says so, and the header, rail and the other pages keep working. Key it on
 * what it holds, so leaving a broken page starts the next one clean.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { Banner } from "../ui/Banner.tsx";

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  override state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { error: error instanceof Error ? error : new Error(String(error)) };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;
    return (
      <div className="rw-page-error" data-testid="page.error">
        <Banner
          tone="danger"
          action={
            <button type="button" className="rw-button" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
          }
        >
          This page stopped working: {error.message}
        </Banner>
      </div>
    );
  }
}
