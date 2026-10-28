// The transport seam for tests: fetch with the same rules as the Python bridge's dav() —
// Basic auth added here, no redirects, 30 s timeout, capped bodies, strict UTF-8 keeping a BOM
// (base64 otherwise), and the connect / network / timeout distinction.
import type { DavResult, Send } from "../src/core/transport.ts";

const MB = 1024 * 1024;
const CAP_MULTISTATUS = 16 * MB;
const CAP_OBJECT = 12 * MB;
const CAP_SMALL = 64 * 1024;

/** Every request the transport sent, as "METHOD path". */
export type RequestLog = string[];

export function fetchTransport(opts: {
	user: string;
	password: string;
	log?: RequestLog;
	timeoutMs?: number;
}): Send {
	const auth = `Basic ${Buffer.from(`${opts.user}:${opts.password}`).toString("base64")}`;
	return async (req): Promise<DavResult> => {
		opts.log?.push(`${req.method} ${new URL(req.url).pathname}`);
		const headers: Record<string, string> = {};
		for (const [k, v] of Object.entries(req.headers))
			if (!/^(authorization|cookie)$/i.test(k)) headers[k] = v;
		let res: Response;
		try {
			res = await fetch(req.url, {
				method: req.method,
				headers: {
					...headers,
					Authorization: auth,
					"User-Agent": "desk-tasks/test",
				},
				body: req.body,
				redirect: "manual",
				signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
			});
		} catch (err) {
			return failure(err);
		}
		const cap =
			req.method === "GET" && res.status < 300
				? CAP_OBJECT
				: res.status === 207
					? CAP_MULTISTATUS
					: CAP_SMALL;
		let bytes: Uint8Array | null;
		try {
			bytes = await readCapped(res, cap);
		} catch (err) {
			return failure(err);
		}
		if (!bytes)
			return { ok: false, kind: "too-large", message: "body over its cap" };
		const out: Record<string, string> = {};
		res.headers.forEach((v, k) => {
			out[k.toLowerCase()] = v;
		});
		try {
			const body = new TextDecoder("utf-8", {
				fatal: true,
				ignoreBOM: true,
			}).decode(bytes);
			return {
				ok: true,
				status: res.status,
				headers: out,
				body,
				notUtf8: false,
			};
		} catch {
			return {
				ok: true,
				status: res.status,
				headers: out,
				body: Buffer.from(bytes).toString("base64"),
				notUtf8: true,
			};
		}
	};
}

function failure(err: unknown): DavResult {
	const e = err as { name?: string; code?: string; message?: string };
	const text = `${e.name ?? ""} ${e.code ?? ""} ${e.message ?? ""}`;
	if (e.name === "TimeoutError" || /timed? ?out/i.test(text))
		return { ok: false, kind: "timeout", message: "timeout" };
	if (
		/ConnectionRefused|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS/i.test(
			text,
		)
	)
		return { ok: false, kind: "connect", message: "connection failed" };
	return { ok: false, kind: "network", message: "connection lost" };
}

async function readCapped(
	res: Response,
	max: number,
): Promise<Uint8Array | null> {
	if (Number(res.headers.get("content-length") ?? 0) > max) {
		await res.body?.cancel();
		return null;
	}
	const reader = res.body?.getReader();
	if (!reader) return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let size = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > max) {
			await reader.cancel();
			return null;
		}
		chunks.push(value);
	}
	return Buffer.concat(chunks);
}
