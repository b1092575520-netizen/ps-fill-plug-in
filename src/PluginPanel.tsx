import { useEffect, useRef } from "react";
import {
  CloudRecordsPage,
  GenerateAction,
  ModeTabs,
  ModelSettings,
  OutputControls,
  PanelHeader,
  PromptField,
  ReferenceImages,
  Results,
  WriteRecovery,
} from "./components/Shared";
import type { PrototypeController } from "./usePrototypeState";
import { UxpDropdownProvider } from "./components/UxpDropdown";

export function PluginPanel({ controller }: { controller: PrototypeController }) {
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (typeof window === "undefined") return;
    let resizeEndTimer: ReturnType<typeof setTimeout> | undefined;
    const handleResize = () => {
      panelRef.current?.classList.add("is-resizing");
      if (resizeEndTimer) clearTimeout(resizeEndTimer);
      resizeEndTimer = setTimeout(() => panelRef.current?.classList.remove("is-resizing"), 160);
    };
    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      if (resizeEndTimer) clearTimeout(resizeEndTimer);
    };
  }, []);

  const showingResults = controller.workspaceView === "results" && controller.candidates.length > 0;
  const showingForm = !controller.cloudRecordsOpen && controller.workspaceView !== "write-recovery" && !showingResults;
  const view = controller.cloudRecordsOpen ? "cloud-records" : showingForm ? "config" : controller.workspaceView;

  return (
    <UxpDropdownProvider>
      <section ref={panelRef} className="dock-panel plugin-panel">
        <PanelHeader controller={controller} />
        <div className={`panel-scroll panel-view--${view}`}>
          {controller.cloudRecordsOpen ? (
            <CloudRecordsPage controller={controller} />
          ) : controller.workspaceView === "write-recovery" ? (
            <WriteRecovery controller={controller} />
          ) : showingResults ? (
            <Results controller={controller} />
          ) : (
            <>
              <div className="panel-section">
                <ModeTabs controller={controller} />
              </div>
              <div className="panel-section">
                <PromptField controller={controller} />
              </div>
              <div className="panel-section panel-section--fields">
                <OutputControls controller={controller} />
                <ModelSettings controller={controller} />
              </div>
              <div className="panel-section">
                <ReferenceImages controller={controller} />
              </div>
            </>
          )}
        </div>
        {showingForm && (
          <footer className="panel-action-bar">
            <GenerateAction controller={controller} />
          </footer>
        )}
      </section>
    </UxpDropdownProvider>
  );
}
