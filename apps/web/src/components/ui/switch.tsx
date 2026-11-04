import { Switch as Primitive } from "radix-ui";
export function Switch({
  checked,
  onCheckedChange,
  id,
  disabled,
}: {
  checked: boolean;
  onCheckedChange: (v: boolean) => void;
  id: string;
  disabled?: boolean;
}) {
  return (
    <Primitive.Root
      className="switch"
      id={id}
      checked={checked}
      onCheckedChange={onCheckedChange}
      disabled={disabled}
    >
      <Primitive.Thumb className="switch-thumb" />
    </Primitive.Root>
  );
}
