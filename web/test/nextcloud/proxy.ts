// A transparent proxy between the core and the test Nextcloud: it counts requests (to prove
// "zero writes") and simulates what can't be provoked on demand.
const READS = new Set(["GET", "PROPFIND", "REPORT", "HEAD"]);

export interface TestProxy {
	url: string;
	requests: string[];
	/** GETs of this href come back with one byte changed. */
	tamperGet: string | null;
	/** Forward the next write, then answer like a broken gateway. */
	garbleNextWrite: boolean;
	/** Forward the next write, then answer 500 (an applied write reported as an error). */
	error500NextWrite: boolean;
	/** Answer 500 to GETs of this href (the read-back after a write fails). */
	failGet: string | null;
	/** Answer 500 to listings of this collection. */
	failCollection: string | null;
	writes(): string[];
	stop(): void;
}

export function startProxy(upstream: string): TestProxy {
	const p: TestProxy = {
		url: "",
		requests: [],
		tamperGet: null,
		garbleNextWrite: false,
		error500NextWrite: false,
		failGet: null,
		failCollection: null,
		writes: () => p.requests.filter((r) => !READS.has(r.split(" ")[0] ?? "")),
		stop: () => server.stop(true),
	};
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			p.requests.push(`${req.method} ${url.pathname}`);
			const body =
				READS.has(req.method) &&
				req.method !== "PROPFIND" &&
				req.method !== "REPORT"
					? undefined
					: await req.arrayBuffer();
			const headers = new Headers(req.headers);
			headers.delete("host");
			const dest = headers.get("destination");
			if (dest)
				headers.set("destination", `${upstream}${new URL(dest).pathname}`);
			const up = await fetch(`${upstream}${url.pathname}${url.search}`, {
				method: req.method,
				headers,
				body,
				redirect: "manual",
			});
			let text = await up.arrayBuffer();
			if (req.method === "GET" && url.pathname === p.failGet)
				return new Response("oops", { status: 500 });
			if (
				(req.method === "REPORT" || req.method === "PROPFIND") &&
				url.pathname === p.failCollection
			)
				return new Response("oops", { status: 500 });
			if (!READS.has(req.method) && p.error500NextWrite) {
				p.error500NextWrite = false;
				return new Response("Internal Server Error", { status: 500 });
			}
			if (!READS.has(req.method) && p.garbleNextWrite) {
				p.garbleNextWrite = false;
				return new Response("<html>502 Bad Gateway</html>", { status: 502 });
			}
			if (req.method === "GET" && url.pathname === p.tamperGet) {
				const s = new TextDecoder()
					.decode(text)
					.replace("SUMMARY:", "SUMMARY:x");
				text = new TextEncoder().encode(s).buffer as ArrayBuffer;
			}
			const out = new Headers(up.headers);
			out.delete("content-length");
			out.delete("content-encoding");
			out.delete("transfer-encoding");
			return new Response(text, { status: up.status, headers: out });
		},
	});
	p.url = `http://localhost:${server.port}`;
	return p;
}
