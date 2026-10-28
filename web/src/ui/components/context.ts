// The controller, for every component (one app, one controller).
import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { Controller } from "../controller.ts";

export const AppContext = createContext<Controller | null>(null);

export function useApp(): Controller {
	const c = useContext(AppContext);
	if (!c) throw new Error("Broken invariant: no controller in context.");
	return c;
}
