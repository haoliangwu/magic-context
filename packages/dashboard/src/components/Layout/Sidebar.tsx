import type { ThemePreference } from "../../lib/theme";
import type { NavSection } from "../../lib/types";
import Icon, { type IconName } from "../shared/Icon";

const NAV_ITEMS: { id: NavSection; icon: IconName; label: string }[] = [
  { id: "projects", icon: "folder", label: "Projects" },
  { id: "workspaces", icon: "layers", label: "Workspaces" },
  { id: "cache", icon: "gauge", label: "Cache" },
  { id: "user-memories", icon: "user", label: "User Directives" },
  { id: "config", icon: "sliders", label: "Config" },
  { id: "logs", icon: "list", label: "Logs" },
];

const THEME_OPTIONS: { id: ThemePreference; label: string; title: string }[] = [
  { id: "system", label: "System", title: "Follow the operating system appearance" },
  { id: "light", label: "Light", title: "Always use the light theme" },
  { id: "dark", label: "Dark", title: "Always use the dark theme" },
];

interface Props {
  active: NavSection;
  onNavigate: (section: NavSection) => void;
  theme: ThemePreference;
  onThemeChange: (theme: ThemePreference) => void;
}

export default function Sidebar(props: Props) {
  return (
    <nav class="nav">
      {NAV_ITEMS.map((item) => (
        <button
          type="button"
          class={`nav-item ${props.active === item.id ? "active" : ""}`}
          aria-current={props.active === item.id ? "page" : undefined}
          onClick={() => props.onNavigate(item.id)}
          title={item.label}
        >
          <span class="nav-icon">
            <Icon name={item.icon} size={17} />
          </span>
          <span class="nav-label">{item.label}</span>
        </button>
      ))}
      <div class="nav-theme">
        <fieldset class="nav-theme-fieldset">
          <legend class="nav-theme-label">Theme</legend>
          <div class="nav-theme-options">
            {THEME_OPTIONS.map((option) => (
              <button
                type="button"
                aria-pressed={props.theme === option.id}
                class={`nav-theme-option ${props.theme === option.id ? "active" : ""}`}
                title={option.title}
                onClick={() => props.onThemeChange(option.id)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </fieldset>
      </div>
    </nav>
  );
}
