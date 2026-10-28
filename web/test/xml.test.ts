import { describe, expect, test } from "bun:test";
import {
	APPLE,
	CALDAV,
	DAV,
	esc,
	kid,
	kids,
	parseXml,
	XmlError,
} from "../src/core/xml.ts";

// Shape of a real Nextcloud 34/35 answer: prefixes declared on the root and inline (x1:).
const MULTISTATUS = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav" xmlns:cs="http://calendarserver.org/ns/">
 <d:response><d:href>/remote.php/dav/calendars/admin/work/</d:href>
  <d:propstat><d:prop>
   <d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
   <d:displayname>Work &amp; more</d:displayname>
   <cal:supported-calendar-component-set><cal:comp name="VTODO"/></cal:supported-calendar-component-set>
   <x1:calendar-color xmlns:x1="http://apple.com/ns/ical/">#FF7A00FF</x1:calendar-color>
   <d:getetag>&quot;abc&quot;</d:getetag>
   <cal:calendar-data><![CDATA[BEGIN:VCALENDAR]]>&#13;&#10;END</cal:calendar-data>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
 </d:response>
</d:multistatus>`;

describe("XML reader", () => {
	test("resolves namespaces, entities, CDATA and attributes", () => {
		const root = parseXml(MULTISTATUS);
		expect(root).toMatchObject({ ns: DAV, name: "multistatus" });
		const prop = kid(
			kid(kid(root, DAV, "response"), DAV, "propstat"),
			DAV,
			"prop",
		);
		expect(kid(prop, DAV, "displayname")?.text).toBe("Work & more");
		expect(kid(prop, APPLE, "calendar-color")?.text).toBe("#FF7A00FF");
		expect(kid(prop, DAV, "getetag")?.text).toBe('"abc"');
		expect(kid(prop, CALDAV, "calendar-data")?.text).toBe(
			"BEGIN:VCALENDAR\r\nEND",
		);
		const comps = kids(
			kid(prop, CALDAV, "supported-calendar-component-set"),
			CALDAV,
			"comp",
		);
		expect(comps.map((c) => c.attrs.name)).toEqual(["VTODO"]);
		// Same local name, other namespace: not confused.
		expect(kid(prop, CALDAV, "displayname")).toBeUndefined();
	});

	test("refuses what it doesn't understand", () => {
		for (const bad of [
			'<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>',
			"<x>&nbsp;</x>",
			"<a><b></a></b>",
			"<p:x/>",
			"<x></x><y/>",
			"<x>",
			"",
		])
			expect(() => parseXml(bad)).toThrow(XmlError);
	});

	test("escapes text for requests", () => {
		expect(esc(`a<b>&"c'`)).toBe("a&lt;b&gt;&amp;&quot;c&apos;");
	});
});

test("a huge attribute-less tag is refused in linear time", () => {
	const t0 = performance.now();
	expect(() => parseXml(`<a ${"x".repeat(400_000)}></a>`)).toThrow(XmlError);
	expect(performance.now() - t0).toBeLessThan(500);
});
