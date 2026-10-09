import { createEffect, createSignal, type JSX, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";

/** Keep menus out of scroll containers and place them within the visible viewport. */
export default function FloatingLayer(props: {
  anchor: HTMLElement;
  onClose: () => void;
  children: JSX.Element;
  class?: string;
}) {
  let layer: HTMLDivElement | undefined;
  const [position, setPosition] = createSignal<JSX.CSSProperties>({});
  createEffect(() => {
    const place = () => {
      const rect = props.anchor.getBoundingClientRect();
      const width = Math.min(Math.max(rect.width, 320), window.innerWidth - 24);
      const below = window.innerHeight - rect.bottom - 12;
      const height = Math.min(360, Math.max(below, rect.top - 12));
      const placeBelow = below >= Math.min(300, height);
      setPosition({
        position: "fixed",
        left: `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`,
        top: placeBelow ? `${rect.bottom + 4}px` : "auto",
        bottom: placeBelow ? "auto" : `${window.innerHeight - rect.top + 4}px`,
        width: `${width}px`,
        "max-height": `${height}px`,
        "z-index": 1000,
      });
    };
    const outside = (event: PointerEvent) => {
      if (!props.anchor.contains(event.target as Node) && !layer?.contains(event.target as Node)) {
        props.onClose();
      }
    };
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
        props.anchor.focus();
      }
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keyboard);
    onCleanup(() => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keyboard);
    });
  });
  return (
    <Portal>
      <div class={props.class ?? "model-select-dropdown"} ref={layer} style={position()}>
        {props.children}
      </div>
    </Portal>
  );
}
