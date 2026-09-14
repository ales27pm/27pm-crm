import type { ImgHTMLAttributes } from "react";

export type IllustrationName =
  | "access-denied"
  | "accounts-empty"
  | "connection-error"
  | "inbox-empty"
  | "pipeline-empty"
  | "projects-empty"
  | "search-empty"
  | "strategy-empty"
  | "tasks-clear"
  | "thread-select";

type IllustrationProps = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "alt" | "height" | "src" | "width"
> & { name: IllustrationName };

/**
 * Decorative artwork for a state whose accessible message is rendered in
 * adjacent HTML. The fixed intrinsic size prevents layout shift.
 */
export function Illustration({ name, ...props }: IllustrationProps) {
  return (
    // The published SVG is already optimized; using the native element also
    // keeps this decorative helper server-renderable in component tests.
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={`/visual-assets/illustrations/${name}.svg`}
      alt=""
      width={320}
      height={220}
      loading="lazy"
      decoding="async"
      {...props}
    />
  );
}
