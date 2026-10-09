import schema from "../../../../../assets/magic-context.schema.json";

export interface ConfigSchemaNode {
  properties?: Record<string, ConfigSchemaNode>;
  default?: unknown;
  minimum?: number;
  maximum?: number;
}

export function configSchemaNode(path: string): ConfigSchemaNode | undefined {
  let node: ConfigSchemaNode | undefined = schema as ConfigSchemaNode;
  for (const part of path.split(".")) node = node?.properties?.[part];
  return node;
}

/** Parent object defaults sometimes contain values absent from the leaf schema. */
export function configDefault(path: string): unknown {
  const parts = path.split(".");
  let node: ConfigSchemaNode | undefined = schema as ConfigSchemaNode;
  let inherited: unknown;
  for (const part of parts) {
    const parentDefault = node?.default ?? inherited;
    inherited =
      parentDefault && typeof parentDefault === "object"
        ? (parentDefault as Record<string, unknown>)[part]
        : undefined;
    node = node?.properties?.[part];
  }
  // auto_update is optional in the schema, but the runtime opts out only on false.
  return inherited ?? node?.default ?? (path === "auto_update" ? true : undefined);
}

export function defaultLabel(path: string): string {
  const value = configDefault(path);
  return value === undefined
    ? "No override"
    : value === true
      ? "on"
      : value === false
        ? "off"
        : String(value);
}

export function defaultPlaceholder(path: string, unset = "No override"): string {
  const value = configDefault(path);
  return value === undefined ? unset : `Default: ${String(value)}`;
}
