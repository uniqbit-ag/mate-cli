import { createContext } from "react";

/** The companion the board acts on; set once by the Factory view. */
export const FactoryCompanion = createContext<string>("");
