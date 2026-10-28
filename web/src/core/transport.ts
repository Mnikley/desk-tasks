// The transport seam: one HTTP request to Nextcloud. In the app it is the Python bridge's
// `dav()` (which adds the app password, enforces the origin and caps body sizes); in tests it is
// `fetch` against the fake server or Docker Nextcloud (web/test/transport.ts).

export const DAV_METHODS = [
	"GET",
	"PUT",
	"DELETE",
	"MOVE",
	"PROPFIND",
	"PROPPATCH",
	"REPORT",
	"MKCALENDAR",
	"POST",
] as const;
export type DavMethod = (typeof DAV_METHODS)[number];

export interface DavRequest {
	method: DavMethod;
	/** Absolute URL on the configured origin. */
	url: string;
	headers: Record<string, string>;
	body?: string;
}

/**
 * Why no answer came back. `connect`: nothing was sent (DNS, refused, TLS), so a write is a plain
 * failure. `network`/`timeout`: the request may have reached the server, so a write's outcome is
 * unknown. `too-large`: the body was over its cap. `refused`: the bridge refused the request.
 */
export type TransportFailure =
	| "connect"
	| "network"
	| "timeout"
	| "too-large"
	| "refused";

export type DavResult =
	| {
			ok: true;
			status: number;
			/** Lower-case header names. */
			headers: Record<string, string>;
			/** Strict UTF-8 (a byte-order mark kept), or base64 when `notUtf8`. */
			body: string;
			notUtf8: boolean;
	  }
	| { ok: false; kind: TransportFailure; message: string };

export type Send = (req: DavRequest) => Promise<DavResult>;

/** Decodes a base64 body that wasn't UTF-8, for display only (invalid bytes become U+FFFD). */
export function lossyText(base64: string): string {
	const bin = atob(base64);
	const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
	return new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
}
