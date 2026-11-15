import { Component, type ErrorInfo, type ReactNode } from "react";

// The app's one render-error boundary, wrapped around <App /> in
// main.tsx (#281): a throw no component catches must not blank the
// whole tree — the operator gets the message plus a reload instead of
// a white page. One boundary at the root is deliberate: it is the last
// line of defense, not per-section recovery — sections degrade their
// own data (see the skew guards in SettingsAccounts/SettingsVoice).

interface State {
	error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
	override state: State = { error: null };

	static getDerivedStateFromError(error: Error): State {
		return { error };
	}

	// Client code — this is the browser's error path, so console.error
	// (devtools + anything watching the console) is the reporting sink.
	override componentDidCatch(error: Error, info: ErrorInfo): void {
		console.error("render failed", error, info.componentStack);
	}

	override render(): ReactNode {
		const { error } = this.state;
		if (error === null) return this.props.children;
		return (
			<div className="error-boundary" role="alert">
				<p>Something went wrong. The page hit an error it could not draw.</p>
				<pre>{error.message}</pre>
				<button type="button" onClick={() => location.reload()}>
					Reload
				</button>
			</div>
		);
	}
}
