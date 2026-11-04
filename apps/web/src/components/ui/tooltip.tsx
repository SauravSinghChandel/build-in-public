import { Tooltip as T } from "radix-ui";
import type { ReactNode } from "react";
export function Tooltip({
  text,
  children,
}: {
  text: string;
  children: ReactNode;
}) {
  return (
    <T.Provider delayDuration={200}>
      <T.Root>
        <T.Trigger asChild>{children}</T.Trigger>
        <T.Portal>
          <T.Content className="tooltip" sideOffset={6}>
            {text}
            <T.Arrow />
          </T.Content>
        </T.Portal>
      </T.Root>
    </T.Provider>
  );
}
