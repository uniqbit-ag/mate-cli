/** The slice of wterm's `WTerm` Studio uses. */
export interface WTermInstance {
  cols: number;
  rows: number;
  onData: ((data: string) => void) | null;
  onResize: (() => void) | null;
  init(): Promise<void>;
  fit(): void;
  write(data: string | Uint8Array): void;
  focus(): void;
  destroy(): void;
}

export type WTermConstructor = new (
  mount: HTMLElement,
  options: {
    cursorBlink: boolean;
    autoResize: boolean;
    wasmUrl: string;
    onClipboardWrite?: (text: string) => void;
  },
) => WTermInstance;

let loading: Promise<WTermConstructor> | null = null;

/**
 * Loads the terminal, bundled as its own chunk with its stylesheet, only when a terminal is first
 * shown. The WASM core is served by Studio itself (`TERMINAL_WASM`), matching the installed version.
 */
export function loadWTerm(): Promise<WTermConstructor> {
  loading ??= Promise.all([import("@wterm/dom"), import("@wterm/dom/css")])
    .then(([module]) => module.WTerm as unknown as WTermConstructor)
    .catch((error: unknown) => {
      loading = null;
      throw error;
    });
  return loading;
}
