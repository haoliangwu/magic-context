import { spyOn } from "bun:test";
import * as contextHandler from "../context-handler";

const register = contextHandler.registerPiContextHandler;
const retainedReads = 16;

// Retaining recent read results is already supported user configuration. Use
// that existing protection to exercise held-head replay without changing age.
spyOn(contextHandler, "registerPiContextHandler").mockImplementation(
	(pi, options) =>
		register(pi, {
			...options,
			protectedTools: { ...options.protectedTools, read: retainedReads },
		}),
);
