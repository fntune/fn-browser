import { Moon, Sun, Monitor } from "lucide-react";
import { Button } from "../ui/button.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.js";
import type { ThemeSetting } from "../hooks/use-theme.js";

export function ThemeToggle({
  setting,
  onCycle,
}: {
  setting: ThemeSetting;
  onCycle: () => void;
}): React.JSX.Element {
  const Icon = setting === "light" ? Sun : setting === "dark" ? Moon : Monitor;
  const label =
    setting === "light" ? "Light" : setting === "dark" ? "Dark" : "Auto (system)";
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button variant="ghost" size="icon" onClick={onCycle} aria-label={`Theme: ${label}`}>
          <Icon />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}
