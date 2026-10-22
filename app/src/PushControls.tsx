import { useState } from "react";
import {
	getPushPublicKey,
	getPushStatus,
	registerPushSubscription,
	unregisterPushSubscription,
} from "./api.ts";
import { describe, KV, useLoad } from "./opsShared.tsx";
import type { AppPushStatus, AppPushSubscriptionRequest } from "../../src/http/app-wire.ts";

interface PushState {
	status: AppPushStatus;
	supported: boolean;
	subscribed: boolean;
	currentEndpoint: string | null;
	currentHash: string | null;
	permission: NotificationPermission | "unsupported";
}

async function endpointHash(endpoint: string): Promise<string | null> {
	if (globalThis.crypto?.subtle === undefined) return null;
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function vapidBytes(publicKey: string): Uint8Array<ArrayBuffer> {
	const base64 = publicKey.replace(/-/g, "+").replace(/_/g, "/");
	const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
	const raw = atob(padded);
	return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function subscriptionBody(sub: PushSubscription): AppPushSubscriptionRequest {
	const json = sub.toJSON();
	if (
		typeof json.endpoint !== "string" ||
		typeof json.keys?.p256dh !== "string" ||
		typeof json.keys.auth !== "string"
	) {
		throw new Error("browser returned an incomplete push subscription");
	}
	return {
		endpoint: json.endpoint,
		expirationTime: json.expirationTime ?? null,
		keys: { p256dh: json.keys.p256dh, auth: json.keys.auth },
	};
}

async function currentSubscription(): Promise<{
	registration: ServiceWorkerRegistration | null;
	subscription: PushSubscription | null;
}> {
	const registration = (await navigator.serviceWorker.getRegistration("/app/")) ?? null;
	return {
		registration,
		subscription: (await registration?.pushManager.getSubscription()) ?? null,
	};
}

async function loadPushState(token: string | null): Promise<PushState> {
	const supported =
		typeof navigator !== "undefined" &&
		"serviceWorker" in navigator &&
		typeof window !== "undefined" &&
		"PushManager" in window &&
		"Notification" in window;
	const [status, local] = await Promise.all([
		getPushStatus(token),
		supported
			? currentSubscription().then(({ subscription }) => subscription)
			: Promise.resolve(null),
	]);
	return {
		status,
		supported,
		subscribed: local !== null,
		currentEndpoint: local?.endpoint ?? null,
		currentHash: local === null ? null : await endpointHash(local.endpoint),
		permission: supported ? Notification.permission : "unsupported",
	};
}

export function PushControls({ token }: { token: string | null }) {
	const { data, err, reload } = useLoad(() => loadPushState(token));
	const [busy, setBusy] = useState(false);
	const [actErr, setActErr] = useState<string | null>(null);

	const enable = async () => {
		setBusy(true);
		setActErr(null);
		try {
			const permission =
				Notification.permission === "default"
					? await Notification.requestPermission()
					: Notification.permission;
			if (permission !== "granted") {
				setActErr("Notifications are blocked for this browser.");
				return;
			}
			await navigator.serviceWorker.register("/app/sw.js", { scope: "/app/" });
			const registration = await navigator.serviceWorker.ready;
			const { publicKey } = await getPushPublicKey(token);
			const subscription = await registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: vapidBytes(publicKey),
			});
			await registerPushSubscription(token, subscriptionBody(subscription));
			reload();
		} catch (e) {
			setActErr(describe(e));
		} finally {
			setBusy(false);
		}
	};

	const disable = async () => {
		setBusy(true);
		setActErr(null);
		try {
			const { subscription } = await currentSubscription();
			if (subscription !== null) {
				await unregisterPushSubscription(token, subscription.endpoint);
				await subscription.unsubscribe();
			}
			reload();
		} catch (e) {
			setActErr(describe(e));
		} finally {
			setBusy(false);
		}
	};

	if (err !== null) return <p className="error">{err}</p>;
	if (data === null) return null;

	const known =
		data.currentHash !== null &&
		data.status.subscriptions.some((s) => s.endpointHash === data.currentHash);
	const enabled = data.subscribed && known;
	const browserOnly = data.subscribed && !known;
	const state = !data.supported
		? "unsupported"
		: data.permission === "denied"
			? "blocked"
			: enabled
				? "on this device"
				: browserOnly
					? "browser only — re-register"
					: "off";

	return (
		<div className="card">
			<div className="op-item-head">
				<span className="op-item-title">Notifications</span>
				<span className={`pill${enabled ? " on" : ""}`}>{state}</span>
			</div>
			<KV k="server" v={data.status.configured ? "ready" : "no key yet"} />
			<KV k="devices" v={String(data.status.subscriptions.length)} />
			<div className="cap ops-cap">
				Background app turns ring this browser; notifications carry only a link back to the
				conversation.
			</div>
			{actErr !== null && <div className="error">{actErr}</div>}
			{data.supported && (
				<div className="approval-actions">
					{enabled ? (
						<button type="button" disabled={busy} onClick={() => void disable()}>
							Disable on this device
						</button>
					) : (
						<button type="button" disabled={busy} onClick={() => void enable()}>
							Enable on this device
						</button>
					)}
				</div>
			)}
		</div>
	);
}
