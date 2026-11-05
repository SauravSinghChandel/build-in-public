import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import { Slot } from "radix-ui";
import * as React from "react";
import { twMerge } from "tailwind-merge";
export function cn(...values: Parameters<typeof clsx>) {
  return twMerge(clsx(values));
}
const variants = cva("button", {
  variants: {
    variant: {
      default: "primary",
      outline: "secondary",
      ghost: "ghost",
      destructive: "destructive",
    },
    size: { default: "", icon: "icon-button" },
  },
  defaultVariants: { variant: "outline", size: "default" },
});
export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof variants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp className={cn(variants({ variant, size, className }))} {...props} />
  );
}
