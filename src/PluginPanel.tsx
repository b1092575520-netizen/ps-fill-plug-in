import { useEffect, useRef, useState } from "react";
import {
  DetailParameters,
  CloudRecordsPage,
  GenerateAction,
  ModeTabs,
  OutputControls,
  PanelHeader,
  PromptField,
  PromptNotebookPage,
  ReferenceImages,
  Results,
  WriteRecovery,
  SelectionStatusBar,
} from "./components/Shared";
import type { PrototypeController } from "./usePrototypeState";
import { UxpDropdownProvider } from "./components/UxpDropdown";

export function PluginPanel({ controller }: { controller: PrototypeController }) {
  const [notebookOpen, setNotebookOpen] = useState(false);
  const panelRef = useRef<HTMLElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const savedScrollTop = useRef(0);
  const openNotebook = () => {
    savedScrollTop.current = scrollRef.current?.scrollTop ?? 0;
    setNotebookOpen(true);
  };
  const closeNotebook = () => setNotebookOpen(false);
  useEffect(() => {
    if (!notebookOpen && scrollRef.current) scrollRef.current.scrollTop = savedScrollTop.current;
  }, [notebookOpen]);
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

  return (
    <UxpDropdownProvider>
      <section ref={panelRef} className="dock-panel plugin-panel">
      <PanelHeader controller={controller} />
      <div ref={scrollRef} className={`panel-scroll ${controller.cloudRecordsOpen ? "panel-view--cloud-records" : notebookOpen ? "panel-view--notebook" : `panel-view--${controller.workspaceView}`}`}>
        {controller.cloudRecordsOpen ? (
          <CloudRecordsPage controller={controller} />
        ) : notebookOpen ? (
          <PromptNotebookPage controller={controller} onClose={closeNotebook} />
        ) : controller.workspaceView === "write-recovery" ? (
          <div className="panel-section panel-section--write-recovery">
            <WriteRecovery controller={controller} />
          </div>
        ) : controller.workspaceView === "results" && controller.candidates.length ? (
          <div className="panel-section panel-section--results">
            <Results controller={controller} />
          </div>
        ) : (
          <>
            <div className="panel-section panel-section--mode">
              <section className="property-section">
                <div className="property-heading"><span>生成方式</span></div>
                <ModeTabs controller={controller} />
                {controller.draft.mode === "inpaint" && <SelectionStatusBar controller={controller} />}
              </section>
            </div>
            <div className="panel-section panel-section--prompt">
              <section className="property-section">
                <PromptField controller={controller} onOpenNotebook={openNotebook} />
              </section>
            </div>
            {controller.draft.mode !== "inpaint" && <div className="panel-section panel-section--output">
              <section className="property-section">
                <div className="property-heading"><span>输出</span></div>
                <OutputControls controller={controller} compact />
              </section>
            </div>}
            <div className="panel-section panel-section--parameters">
              <section className="property-section">
                <DetailParameters controller={controller} title="参数" showHeading={false} />
              </section>
            </div>
            {controller.draft.mode !== "inpaint" && <div className="panel-section panel-section--references">
              <section className="property-section">
                <ReferenceImages controller={controller} showHeading={false} />
              </section>
            </div>}
          </>
        )}
      </div>
      {!notebookOpen && !controller.cloudRecordsOpen && controller.workspaceView !== "write-recovery" && !(controller.workspaceView === "results" && controller.candidates.length) && (
        <footer className="panel-action-bar">
          <GenerateAction controller={controller} />
        </footer>
      )}
      </section>
    </UxpDropdownProvider>
  );
}
