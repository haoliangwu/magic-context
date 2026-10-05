import configSchema from "../../../../../assets/magic-context.schema.json";

type SchemaNode = {
  properties?: Record<string, SchemaNode>;
  "x-mc-live-reload"?: boolean;
};

export function isLiveConfigKey(path: string): boolean {
  let node: SchemaNode | undefined = configSchema as SchemaNode;
  for (const part of path.split(".")) node = node?.properties?.[part];
  return node?.["x-mc-live-reload"] === true;
}
