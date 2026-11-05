import { X } from "lucide-react";
import { Dialog as Primitive } from "radix-ui";
import type { ReactNode } from "react";
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  sheet = false,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  sheet?: boolean;
}) {
  return (
    <Primitive.Root open={open} onOpenChange={onOpenChange}>
      <Primitive.Portal>
        <Primitive.Overlay className="overlay" />
        <Primitive.Content className={sheet ? "dialog sheet" : "dialog"}>
          <Primitive.Title>{title}</Primitive.Title>
          <Primitive.Description className={description ? "muted" : "sr-only"}>
            {description || title}
          </Primitive.Description>
          <Primitive.Close
            className="dialog-close icon-button button ghost"
            aria-label="Close"
          >
            <X />
          </Primitive.Close>
          {children}
        </Primitive.Content>
      </Primitive.Portal>
    </Primitive.Root>
  );
}
