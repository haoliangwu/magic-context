import { Show } from "solid-js";
import { isLiveConfigKey } from "./live-config-key";

export default function LiveBadge(props: { path: string }) {
  return (
    <Show when={isLiveConfigKey(props.path)}>
      <span class="config-live-badge" title="applies from the next run, no restart">
        Live
      </span>
    </Show>
  );
}
