// Minimal namespace-aware XML reader for WebDAV multistatus answers. Strict: anything it doesn't
// understand (DOCTYPE, unknown entities, unbalanced tags) is an error, never a guess.

export interface XmlElement {
	ns: string;
	name: string;
	/** Attributes without a namespace prefix, by name (namespace declarations excluded). */
	attrs: Record<string, string>;
	children: XmlElement[];
	/** Concatenated character data directly inside this element (entities decoded). */
	text: string;
}

export const DAV = "DAV:";
export const CALDAV = "urn:ietf:params:xml:ns:caldav";
export const CS = "http://calendarserver.org/ns/";
export const APPLE = "http://apple.com/ns/ical/";
export const OC = "http://owncloud.org/ns";
export const NC = "http://nextcloud.com/ns";

export class XmlError extends Error {}

const ENTITIES: Record<string, string> = {
	lt: "<",
	gt: ">",
	amp: "&",
	quot: '"',
	apos: "'",
};

function decode(s: string): string {
	return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (_, e: string) => {
		if (e[0] === "#") {
			const code =
				e[1] === "x" ? Number.parseInt(e.slice(2), 16) : Number(e.slice(1));
			if (!Number.isFinite(code) || code > 0x10ffff)
				throw new XmlError(`Bad character reference &${e};`);
			return String.fromCodePoint(code);
		}
		const v = ENTITIES[e];
		if (v === undefined) throw new XmlError(`Unknown entity &${e};`);
		return v;
	});
}

interface Open {
	el: XmlElement;
	qname: string;
	/** prefix → namespace URI in scope for this element. */
	scope: Map<string, string>;
}

/** Parses an XML document into its root element. */
export function parseXml(xml: string): XmlElement {
	let i = 0;
	const stack: Open[] = [];
	let root: XmlElement | null = null;
	const top = () => stack[stack.length - 1];
	while (i < xml.length) {
		const lt = xml.indexOf("<", i);
		const textEnd = lt === -1 ? xml.length : lt;
		if (textEnd > i) {
			const raw = xml.slice(i, textEnd);
			const t = top();
			if (t) t.el.text += decode(raw);
			else if (raw.trim()) throw new XmlError("Text outside the root element.");
		}
		if (lt === -1) break;
		if (xml.startsWith("<?", lt)) {
			const end = xml.indexOf("?>", lt);
			if (end === -1)
				throw new XmlError("Unterminated processing instruction.");
			i = end + 2;
		} else if (xml.startsWith("<!--", lt)) {
			const end = xml.indexOf("-->", lt);
			if (end === -1) throw new XmlError("Unterminated comment.");
			i = end + 3;
		} else if (xml.startsWith("<![CDATA[", lt)) {
			const end = xml.indexOf("]]>", lt);
			const t = top();
			if (end === -1 || !t) throw new XmlError("Misplaced CDATA section.");
			t.el.text += xml.slice(lt + 9, end);
			i = end + 3;
		} else if (xml.startsWith("<!", lt)) {
			throw new XmlError("DOCTYPE declarations are not accepted.");
		} else if (xml[lt + 1] === "/") {
			const end = xml.indexOf(">", lt);
			if (end === -1) throw new XmlError("Unterminated end tag.");
			const qname = xml.slice(lt + 2, end).trim();
			const open = stack.pop();
			if (!open || open.qname !== qname)
				throw new XmlError(`Unexpected </${qname}>.`);
			i = end + 1;
		} else {
			const end = tagEnd(xml, lt);
			const selfClosing = xml[end - 1] === "/";
			const inner = xml.slice(lt + 1, selfClosing ? end - 1 : end);
			const m = /^([^\s/>]+)/.exec(inner);
			if (!m?.[1]) throw new XmlError("Empty tag name.");
			const qname = m[1];
			const scope = new Map(top()?.scope ?? []);
			const attrs: Record<string, string> = {};
			for (const [attr, raw] of attributes(inner, qname.length)) {
				const value = decode(raw);
				if (attr === "xmlns") scope.set("", value);
				else if (attr.startsWith("xmlns:")) scope.set(attr.slice(6), value);
				else if (!attr.includes(":")) attrs[attr] = value;
			}
			const colon = qname.indexOf(":");
			const prefix = colon === -1 ? "" : qname.slice(0, colon);
			const ns = scope.get(prefix);
			if (ns === undefined && prefix)
				throw new XmlError(`Undeclared namespace prefix "${prefix}".`);
			const el: XmlElement = {
				ns: ns ?? "",
				name: colon === -1 ? qname : qname.slice(colon + 1),
				attrs,
				children: [],
				text: "",
			};
			const parent = top();
			if (parent) parent.el.children.push(el);
			else if (root) throw new XmlError("More than one root element.");
			else root = el;
			if (!selfClosing) stack.push({ el, qname, scope });
			i = end + 1;
		}
	}
	if (stack.length) throw new XmlError(`Unclosed <${top()?.qname}>.`);
	if (!root) throw new XmlError("No root element.");
	return root;
}

/** name="value" pairs of a start tag, read in one linear pass (no backtracking regex). */
function attributes(inner: string, from: number): [string, string][] {
	const out: [string, string][] = [];
	let i = from;
	const n = inner.length;
	const space = (c: string | undefined) =>
		c === " " || c === "\t" || c === "\n" || c === "\r";
	while (i < n) {
		while (i < n && space(inner[i])) i++;
		if (i >= n) break;
		const start = i;
		while (i < n && inner[i] !== "=" && !space(inner[i])) i++;
		const name = inner.slice(start, i);
		while (i < n && space(inner[i])) i++;
		if (inner[i] !== "=" || !name)
			throw new XmlError(`Malformed attribute in <${inner.slice(0, 40)}…>.`);
		i++;
		while (i < n && space(inner[i])) i++;
		const quote = inner[i];
		if (quote !== '"' && quote !== "'")
			throw new XmlError("Attribute values must be quoted.");
		const close = inner.indexOf(quote, i + 1);
		if (close === -1) throw new XmlError("Unterminated attribute value.");
		out.push([name, inner.slice(i + 1, close)]);
		i = close + 1;
	}
	return out;
}

/** Index of the ">" closing the tag that starts at `lt`, skipping quoted attribute values. */
function tagEnd(xml: string, lt: number): number {
	let quote = "";
	for (let j = lt + 1; j < xml.length; j++) {
		const c = xml[j];
		if (quote) {
			if (c === quote) quote = "";
		} else if (c === '"' || c === "'") quote = c;
		else if (c === ">") return j;
	}
	throw new XmlError("Unterminated tag.");
}

export const kids = (el: XmlElement | undefined, ns: string, name: string) =>
	el?.children.filter((c) => c.ns === ns && c.name === name) ?? [];

export const kid = (el: XmlElement | undefined, ns: string, name: string) =>
	el?.children.find((c) => c.ns === ns && c.name === name);

/** Escapes text for use inside an XML element or attribute. */
export const esc = (s: string) =>
	s.replace(
		/[<>&"']/g,
		(c) =>
			({
				"<": "&lt;",
				">": "&gt;",
				"&": "&amp;",
				'"': "&quot;",
				"'": "&apos;",
			})[c] ?? c,
	);
