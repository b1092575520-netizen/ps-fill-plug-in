import { GlobalOverlays } from "./components/Shared";
import { PluginPanel } from "./PluginPanel";
import { usePrototypeState } from "./usePrototypeState";

export function App() {
  const controller = usePrototypeState();

  return (
    <main className={`prototype-stage ${controller.settingsOpen ? "settings-is-open" : ""}`} data-theme={controller.theme}>
      <PluginPanel controller={controller} />
      <GlobalOverlays controller={controller} />
    </main>
  );
}
