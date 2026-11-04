import { DropdownMenu as Menu } from "radix-ui";
import { MoreHorizontal } from "lucide-react";
export function CommitMenu({ onMark }: { onMark: () => void }) {
  return (
    <Menu.Root>
      <Menu.Trigger
        className="button ghost icon-button"
        aria-label="Commit actions"
      >
        <MoreHorizontal />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content className="popover" sideOffset={4}>
          <Menu.Item onSelect={onMark}>
            Mark everything up to here as shared
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
