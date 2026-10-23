import { withBase } from "@/lib/base";

/** The kit's horizontal lockup; the `dark` class on <html> picks the on-dark version. */
export function BrandMark() {
  return (
    <span className="inline-flex items-center">
      <img
        src={withBase("/brand/mate-horizontal-color.svg")}
        alt="mate"
        width={81}
        height={24}
        className="h-6 w-auto dark:hidden"
      />
      <img
        src={withBase("/brand/mate-horizontal-on-dark.svg")}
        alt="mate"
        width={81}
        height={24}
        className="hidden h-6 w-auto dark:block"
      />
    </span>
  );
}
