// A tiny observable value and its Preact hook (timesheet's client/lib.ts pattern).
import { useEffect, useState } from "preact/hooks";

export interface Store<T> {
	get(): T;
	set(next: T | ((prev: T) => T)): void;
	subscribe(fn: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
	let value = initial;
	const subs = new Set<() => void>();
	return {
		get: () => value,
		set(next) {
			const v =
				typeof next === "function" ? (next as (p: T) => T)(value) : next;
			if (Object.is(v, value)) return;
			value = v;
			for (const fn of [...subs]) fn();
		},
		subscribe(fn) {
			subs.add(fn);
			return () => subs.delete(fn);
		},
	};
}

/** Re-renders when the store changes, also when it changed between render and subscribing. */
export function useStore<T>(store: Store<T>): T {
	const [, setTick] = useState(0);
	const value = store.get();
	useEffect(() => {
		const off = store.subscribe(() => setTick((n) => n + 1));
		if (!Object.is(store.get(), value)) setTick((n) => n + 1);
		return off;
	}, [store]);
	return value;
}

/** Re-renders on any change of an object with `subscribe` (the core's Store). */
export function useVersion(src: {
	subscribe(fn: () => void): () => void;
}): number {
	const [v, setV] = useState(0);
	useEffect(() => src.subscribe(() => setV((n) => n + 1)), [src]);
	return v;
}
