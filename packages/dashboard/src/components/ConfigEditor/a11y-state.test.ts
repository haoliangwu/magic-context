import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  NOT_SET_TEXT,
  pickerAccessibleName,
  pickerSelectedText,
  radioKeyTarget,
  radioOptionAttributes,
} from "./a11y-state";
import { LANGUAGE_OPTIONS } from "./languages";

const source = (file: string) => readFileSync(resolve(import.meta.dir, file), "utf8");

const PROVIDERS = ["local", "openai-compatible", "off"] as const;

describe("Embedding Provider radio group state", () => {
  it("marks exactly the active provider as checked and puts only it in the Tab order", () => {
    const states = PROVIDERS.map((_, index) =>
      radioOptionAttributes(PROVIDERS, "openai-compatible", index),
    );
    expect(states).toEqual([
      { role: "radio", "aria-checked": false, tabIndex: -1 },
      { role: "radio", "aria-checked": true, tabIndex: 0 },
      { role: "radio", "aria-checked": false, tabIndex: -1 },
    ]);
    expect(radioOptionAttributes(PROVIDERS, "off", 2)["aria-checked"]).toBe(true);
    expect(radioOptionAttributes(PROVIDERS, "off", 0)["aria-checked"]).toBe(false);
  });

  it("keeps the group reachable when the stored provider matches no option", () => {
    const states = PROVIDERS.map((_, index) =>
      radioOptionAttributes<string>(PROVIDERS, "something-else", index),
    );
    expect(states.map((state) => state["aria-checked"])).toEqual([false, false, false]);
    expect(states.map((state) => state.tabIndex)).toEqual([0, -1, -1]);
  });

  it("moves the selection with arrow keys, wrapping, and with Home/End", () => {
    expect(radioKeyTarget("ArrowRight", 0, 3)).toBe(1);
    expect(radioKeyTarget("ArrowDown", 2, 3)).toBe(0);
    expect(radioKeyTarget("ArrowLeft", 0, 3)).toBe(2);
    expect(radioKeyTarget("ArrowUp", 1, 3)).toBe(0);
    expect(radioKeyTarget("Home", 2, 3)).toBe(0);
    expect(radioKeyTarget("End", 0, 3)).toBe(2);
    expect(radioKeyTarget("Enter", 0, 3)).toBeUndefined();
    expect(radioKeyTarget("Tab", 0, 3)).toBeUndefined();
  });

  it("the Config page renders the provider row as a labelled radio group", () => {
    const group = source("RadioButtonGroup.tsx");
    expect(group).toContain('role="radiogroup"');
    expect(group).toContain('role="radio"');
    expect(group).toContain("aria-label={props.label}");
    expect(group).toContain('aria-checked={state()["aria-checked"]}');
    expect(group).toContain("tabIndex={state().tabIndex}");
    expect(group).toContain("radioOptionAttributes(values(), props.value, index())");

    const editor = source("ConfigEditor.tsx");
    expect(editor).toMatch(
      /<RadioButtonGroup\s+label="Embedding Provider"\s+options=\{EMBEDDING_PROVIDER_OPTIONS\}\s+value=\{embeddingProvider\(\)\}/,
    );
  });
});

describe("pop-up picker accessible names", () => {
  it("carries the field label and the current value", () => {
    expect(pickerAccessibleName("Primary variant", "high", "Use harness default")).toBe(
      "Primary variant: high",
    );
    expect(pickerAccessibleName("Fallback thinking level", "auto")).toBe(
      "Fallback thinking level: auto",
    );
  });

  it("says not set when blank, so blank and set no longer read the same", () => {
    expect(pickerAccessibleName("Default variant", undefined, "Use harness default")).toBe(
      `Default variant: ${NOT_SET_TEXT} (Use harness default)`,
    );
    expect(pickerAccessibleName("Default variant", "", "Use harness default")).toBe(
      "Default variant: not set (Use harness default)",
    );
    expect(pickerAccessibleName("Route openai/*", "  ")).toBe("Route openai/*: not set");
    expect(pickerAccessibleName("Default variant", "high", "Use harness default")).not.toBe(
      pickerAccessibleName("Default variant", undefined, "Use harness default"),
    );
  });

  it("Output Language names the chosen language, a custom code, or not set", () => {
    const name = (value: string | undefined) =>
      pickerAccessibleName(
        "Output Language",
        pickerSelectedText(LANGUAGE_OPTIONS, value),
        "No override",
      );
    expect(name("tr")).toBe("Output Language: Turkish (tr)");
    expect(name("xx")).toBe("Output Language: xx");
    expect(name(undefined)).toBe("Output Language: not set (No override)");
  });

  it("the custom pickers use the value-carrying name on their trigger", () => {
    expect(source("SearchPicker.tsx")).toContain(
      "aria-label={pickerAccessibleName(props.label, selectedText(), emptyText())}",
    );
    expect(source("ModelSelect.tsx")).toContain(
      "pickerAccessibleName(props.label, valueStr(), displayValue())",
    );
  });
});

describe("Config page toggle-button groups", () => {
  it("every harness and config-target pill exposes its pressed state", () => {
    const editor = source("ConfigEditor.tsx");
    const pills = [
      ...editor.matchAll(
        /class=\{`tab-pill \$\{([^}]+?) \? "active" : ""\}`\}\s*\n\s*aria-pressed=\{([^}]+)\}/g,
      ),
    ];
    const pillCount = [...editor.matchAll(/class=\{`tab-pill /g)].length;
    expect(pillCount).toBe(6);
    expect(pills).toHaveLength(pillCount);
    for (const [, activeWhen, pressedWhen] of pills) {
      expect(pressedWhen).toBe(activeWhen);
    }
  });
});
